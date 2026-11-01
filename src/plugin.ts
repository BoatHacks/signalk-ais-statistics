// Plugin entry and wiring (ARCHITECTURE 1): AIS events and own position
// in, deltas out at each publish interval, coverage files flushed hourly, REST routes and
// the plotter overlay served while running.
import type { Path, Plugin, ServerAPI } from '@signalk/server-api'
import { Aggregator, HOUR_MS, MINUTE_MS } from './aggregate'
import { registerRoutes, type RouterLike } from './api'
import { configSchema, resolveConfig, type Config } from './config'
import { Coverage } from './coverage'
import {
  connectHistory,
  nullHistoryReader,
  type HistoryReader,
} from './history'
import { Ingest, type IngestStats } from './ingest'
import { LongRangeLog, MAX_PER_DAY } from './longrange'
import { N2kIngest } from './n2k'
import { OwnPosition } from './ownposition'
import {
  buildManifest,
  sectorFeatures,
  registerOverlayProvider,
} from './overlay'
import { buildValues, defaultMetadata, publish } from './publish'
import { SECTOR_CLASSES } from './paths'
import { Query } from './query'

export const PLUGIN_ID = 'signalk-ais-statistics'
/**
 * How often to look for a history provider again while in live-only mode.
 * Providers often register after the plugins start, so the first minutes
 * retry quickly.
 */
const HISTORY_RETRY_FAST_MS = 15 * 1000
const HISTORY_RETRY_FAST_FOR_MS = 5 * MINUTE_MS
const HISTORY_RETRY_MS = 10 * MINUTE_MS

// eslint-disable-next-line @typescript-eslint/no-require-imports
const VERSION: string = require('../package.json').version

interface EventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

interface Running {
  config: Config
  /** One decoder per event and input, so multipart messages stay apart. */
  ingests: { stats: IngestStats }[]
  own: OwnPosition
  agg: Aggregator
  coverage: Coverage
  longRange: LongRangeLog
  query: Query
  history: HistoryReader
  /** Hour index of the last delta that carried the sector paths. */
  sectorHour?: number
  stops: (() => void)[]
}

/**
 * The hour a publish tick belongs to. Ticks fire a second before the end
 * of their interval, so the tick that closes an hour counts as the next.
 */
const tickHour = (time: number) => Math.floor((time + 30_000) / HOUR_MS)

export function createPlugin(app: ServerAPI): Plugin {
  let state: Running | undefined
  let providerRegistered = false

  const log = (msg: string, err?: unknown) =>
    app.error(`${msg}${err instanceof Error ? `: ${err.message}` : ''}`)

  async function setMetadata(): Promise<void> {
    const set = (app as Partial<ServerAPI>).setDefaultMetadata
    if (typeof set !== 'function') return
    for (const { path, meta } of defaultMetadata()) {
      try {
        await set.call(app, path, meta as never)
      } catch (err) {
        log(`setting metadata for ${path} failed`, err)
        return
      }
    }
  }

  async function findHistory(s: Running): Promise<void> {
    const reader = await connectHistory(app)
    if (state !== s) return
    if (reader.available !== s.history.available)
      app.debug(`history ${reader.available ? 'available' : 'unavailable'}`)
    s.history = reader
  }

  function tick(s: Running): void {
    const now = Date.now()
    try {
      // Sector paths once an hour, and on the first tick after a start.
      const hourIndex = tickHour(now)
      const sectors = s.sectorHour !== hourIndex
      const values = buildValues(s.agg, now, s.coverage.today(now), {
        sectors,
      })
      publish(app, PLUGIN_ID, values, now)
      if (sectors) s.sectorHour = hourIndex
    } catch (err) {
      log('publishing failed', err)
    }
    const last = s.agg.lastMessageTime()
    app.setPluginStatus(
      last === undefined
        ? 'Running, no AIS data received yet'
        : `Running, ${s.agg.trackedTargets(now, s.config.targetExpirySeconds * 1000)} targets tracked, history ${s.history.available ? 'available' : 'unavailable (live-only)'}`,
    )
  }

  function hour(s: Running): void {
    s.coverage
      .flush()
      .then(() => s.coverage.prune(Date.now()))
      .catch((err: unknown) => log('writing coverage failed', err))
    s.longRange.enrich((mmsi) => s.agg.vessel(mmsi))
    s.longRange
      .flush()
      .then(() => s.longRange.prune(Date.now()))
      .catch((err: unknown) => log('writing the long-range log failed', err))
  }

  function status() {
    const s = state
    if (!s) return { running: false }
    const now = Date.now()
    const last = s.agg.lastMessageTime()
    const ownAge = s.own.ageMs(now)
    const total = (pick: (st: IngestStats) => number) =>
      s.ingests.reduce((sum, i) => sum + pick(i.stats), 0)
    return {
      running: true,
      version: VERSION,
      startedAt: new Date(s.agg.startedAt).toISOString(),
      noData: last === undefined,
      lastMessageAt: last === undefined ? null : new Date(last).toISOString(),
      trackedTargets: s.agg.trackedTargets(
        now,
        s.config.targetExpirySeconds * 1000,
      ),
      ownPositionAgeSeconds: ownAge === undefined ? null : ownAge / 1000,
      ownPositionFresh: s.own.at(now) !== undefined,
      historyAvailable: s.history.available,
      sentences: total((st) => st.sentences),
      ownSentencesSkipped: total((st) => st.ownSkipped),
      decodeErrors: total((st) => st.decodeErrors),
      incompleteDropped: total((st) => st.incompleteDropped),
      coverageCellsDropped: s.coverage.droppedCells,
      config: s.config,
    }
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'AIS Statistics',
    description:
      'AIS reception statistics: counts, distance percentiles, bearing sectors and coverage',
    schema: () => configSchema,

    start(options) {
      const config = resolveConfig(options)
      const now = Date.now()
      const agg = new Aggregator(now)
      const s: Running = {
        config,
        ingests: [],
        own: new OwnPosition(config.ownPositionMaxAgeSeconds * 1000),
        agg,
        coverage: new Coverage(
          app.getDataDirPath(),
          config.h3Resolution,
          config.coverageRetentionDays,
          config.coverageDistancePercentile,
          now,
        ),
        longRange: new LongRangeLog(
          app.getDataDirPath(),
          config.coverageRetentionDays,
          now,
        ),
        query: undefined as unknown as Query,
        history: nullHistoryReader,
        stops: [],
      }
      s.query = new Query(
        agg,
        () => s.history,
        config.publishIntervalMinutes * 60,
        (err) => log('reading history failed, answered from live data', err),
        (from, to) => s.longRange.entries(from, to, MAX_PER_DAY * 8),
      )
      state = s

      s.coverage
        .load(now)
        .catch((err: unknown) => log('reading coverage failed', err))
      s.longRange
        .load(now)
        .catch((err: unknown) => log('reading the long-range log failed', err))
      void findHistory(s)
      void setMetadata()

      const onInput = (sentences: Ingest, pgns: N2kIngest, input: unknown) => {
        try {
          const time = Date.now()
          // Sentence events carry strings, N2KAnalyzerOut carries PGN objects.
          const msg =
            typeof input === 'string' ? sentences.push(input) : pgns.push(input)
          if (!msg) return
          const located = s.agg.add(msg, s.own.at(time), time)
          if (located) {
            s.coverage.add(
              located.lat,
              located.lon,
              located.distanceNm,
              located.time,
            )
            s.longRange.add(located, s.agg.vessel(located.mmsi))
          }
        } catch (err) {
          // Never let one bad sentence or PGN escape into the server.
          log('processing AIS input failed', err)
        }
      }
      const events = app as unknown as EventSource
      for (const event of config.sentenceEvents) {
        const sentences = new Ingest()
        const pgns = new N2kIngest()
        s.ingests.push(sentences, pgns)
        const listener = (input: unknown) => onInput(sentences, pgns, input)
        events.on(event, listener)
        s.stops.push(() => events.removeListener(event, listener))
      }

      const unsubscribe = app.streambundle
        .getSelfStream('navigation.position' as Path)
        .onValue((pos: unknown) => s.own.update(pos, Date.now()))
      // Some hosts return the stream itself rather than an unsubscribe.
      if (typeof unsubscribe === 'function') s.stops.push(unsubscribe)

      // Publish just before the end of each interval, so every value lands
      // in the bucket it describes. Intervals divide the hour.
      const intervalMs = config.publishIntervalMinutes * MINUTE_MS
      let delay = intervalMs - (now % intervalMs) - 1000
      if (delay < 0) delay += intervalMs
      const first = setTimeout(() => {
        tick(s)
        const every = setInterval(() => tick(s), intervalMs)
        s.stops.push(() => clearInterval(every))
      }, delay)
      s.stops.push(() => clearTimeout(first))
      const hourly = setInterval(() => hour(s), HOUR_MS)
      s.stops.push(() => clearInterval(hourly))
      let retry: ReturnType<typeof setTimeout> | undefined
      const scheduleRetry = () => {
        const fast = Date.now() - now < HISTORY_RETRY_FAST_FOR_MS
        retry = setTimeout(
          () => {
            if (!s.history.available) void findHistory(s)
            scheduleRetry()
          },
          fast ? HISTORY_RETRY_FAST_MS : HISTORY_RETRY_MS,
        )
      }
      scheduleRetry()
      s.stops.push(() => clearTimeout(retry))

      if (config.publishOverlay && !providerRegistered) {
        try {
          registerOverlayProvider(
            app as never,
            PLUGIN_ID,
            () => buildManifest(PLUGIN_ID, VERSION),
            () => state?.config.publishOverlay === true,
          )
          providerRegistered = true
        } catch (err) {
          log('registering the plotter overlay failed', err)
        }
      }

      app.setPluginStatus('Started, waiting for AIS data')
    },

    async stop() {
      const s = state
      state = undefined
      if (!s) return
      for (const stop of s.stops) {
        try {
          stop()
        } catch {
          // keep stopping the rest
        }
      }
      // Flush the open state (SPEC 8): coverage file and a last delta.
      try {
        publish(app, PLUGIN_ID, buildValues(s.agg, Date.now()), Date.now())
      } catch {
        // the server may already be shutting down
      }
      await s.coverage
        .flush()
        .catch((err: unknown) => log('writing coverage failed', err))
      s.longRange.enrich((mmsi) => s.agg.vessel(mmsi))
      await s.longRange
        .flush()
        .catch((err: unknown) => log('writing the long-range log failed', err))
    },

    registerWithRouter(router) {
      registerRoutes(router as unknown as RouterLike, {
        query: () => state?.query,
        coverage: () => state?.coverage,
        longRange: () => state?.longRange,
        status,
        overlayExtras: async () => {
          const s = state
          if (!s) return []
          // One class after the other: history requests go out one at a time.
          const own = s.own.last()
          const out: object[] = []
          for (const cls of SECTOR_CLASSES)
            out.push(
              ...sectorFeatures(
                await s.query.sectors('24h', cls, Date.now()),
                own,
              ),
            )
          return out
        },
      })
    },
  }
  return plugin
}
