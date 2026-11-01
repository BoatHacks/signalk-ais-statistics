// Windowed queries (ARCHITECTURE 2.8). Combines history read back through
// the HistoryReader with the live state of the aggregator. With history, a
// window total is the sum of counter increments (with reset detection) and
// window percentiles come from the increments of the distance bin
// counters. Without history (live-only mode) the same figures come from
// the aggregator's minute and hour buckets, which reach back 24 hours.
import { M_PER_NM } from './geo'
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  emptyBucket,
  mergeInto,
  sectorP99,
  type Aggregator,
  type Bucket,
} from './aggregate'
import { sectorOf } from './geo'
import { increments, type Aggregate, type HistoryReader } from './history'
import type { LongRangeEntry } from './longrange'
import { addInto, emptyBins, summarize } from './histogram'
import {
  DISTANCE_BIN_COUNT,
  HEALTH_KINDS,
  SECTOR_CLASSES,
  SECTOR_COUNT,
  SECTOR_WIDTH_DEG,
  distanceBinPaths,
  healthPaths,
  paths,
  type HealthKind,
  type SectorClass,
  type TypeGroup,
} from './paths'

export const WINDOWS = {
  '1h': { ms: HOUR_MS, resolution: 60 },
  '24h': { ms: DAY_MS, resolution: 300 },
  '7d': { ms: 7 * DAY_MS, resolution: 3600 },
} as const
export type WindowName = keyof typeof WINDOWS

export function isWindow(w: unknown): w is WindowName {
  return typeof w === 'string' && Object.hasOwn(WINDOWS, w)
}

export const METRICS = [
  'messages',
  'positions',
  'distance',
  'vessels',
  'health',
] as const
export type Metric = (typeof METRICS)[number]
export const MAX_SERIES_POINTS = 2000
/**
 * An hour counts toward a sector's distance only with at least this
 * many reports in that sector: the p99 of a handful of reports lands at the
 * top of its distance bin, so sparse hours would set the radius by chance
 * (chosen by the maintainer).
 */
export const MIN_SECTOR_REPORTS = 20

export type Source = 'history' | 'live'

/**
 * Shown instead of the provider's own error, which can be a long database
 * message; the full error goes to the server log.
 */
export const HISTORY_FAILED =
  'The history provider could not answer, so these figures are live data from at most the last 24 hours.'

/** Shown when the weather read fails; there is no live fallback. */
export const WEATHER_FAILED =
  'The history provider could not answer, so no weather can be shown.'

/** Weather is read hourly, like the range it is compared with. */
export const WEATHER_RESOLUTION = 3600

export interface WeatherSeries {
  path: string
  values: (number | null)[]
}

/** Weather read back from history for the range vs weather panel. */
export interface WeatherResult {
  /** False without a history provider: there is no live weather record. */
  available: boolean
  resolution: number
  /** The aggregate the values are, normally hourly averages. */
  aggregate: Aggregate
  times: string[]
  /** Only paths with at least one value in the range. */
  series: WeatherSeries[]
  historyError?: string
}

export interface DistanceFigures {
  count: number
  /** Metres, like every distance the queries return. */
  avgM: number | null
  medianM: number | null
  p95M: number | null
  p99M: number | null
  /** Untrusted: one bogus position sets it (SPEC 2.3). */
  maxM: number | null
}

export interface Summary {
  window: WindowName
  from: string
  to: string
  source: Source
  messages: number
  positions: { classA: number; classB: number; other: number }
  /** Unique vessels; null for windows over 24 hours, which are not additive. */
  vessels: { total: number; byGroup: Record<TypeGroup, number> } | null
  distance: DistanceFigures
  health: HealthFigures
  /** Set when history failed and the figures fell back to live data. */
  historyError?: string
}

/** Message health over a window (SPEC 2.8). */
export interface HealthFigures {
  /** Everything received: decoded messages, decode errors and incomplete. */
  received: number
  counts: Record<HealthKind, number>
}

function healthFigures(
  messages: number,
  counts: Record<HealthKind, number>,
): HealthFigures {
  return {
    received: messages + counts.decodeErrors + counts.incomplete,
    counts,
  }
}

export interface SectorStat {
  sector: number
  fromDeg: number
  toDeg: number
  count: number
  p99M: number | null
  /** Farthest reception in the window, untrusted. */
  maxM: number | null
  /** When it was received, when known to the second. */
  maxAt: string | null
  /** Otherwise the start of the hour it was received in. */
  maxHour: string | null
}

export interface SectorStats {
  window: WindowName
  class: SectorClass | 'all'
  source: Source
  sectors: SectorStat[]
  historyError?: string
}

export interface SeriesResult {
  metric: Metric
  source: Source
  resolution: number
  times: string[]
  historyError?: string
  [column: string]: unknown
}

const nul = (v: number | undefined): number | null =>
  v === undefined || !Number.isFinite(v) ? null : v

/** Nautical miles, as kept internally, to metres or null. */
const metres = (nm: number | undefined): number | null => {
  const v = nul(nm)
  return v === null ? null : Math.round(v * M_PER_NM)
}

/** A distance read back from history (metres) to nautical miles. */
const toNm = (m: number | undefined | null): number | undefined =>
  m === undefined || m === null ? undefined : m / M_PER_NM

function distanceFigures(bins: number[], maxNm?: number): DistanceFigures {
  const s = summarize(bins, maxNm)
  return {
    count: s.count,
    avgM: metres(s.avgNm),
    medianM: metres(s.medianNm),
    p95M: metres(s.p95Nm),
    p99M: metres(s.p99Nm),
    maxM: metres(maxNm),
  }
}

const HEALTH_PATHS = HEALTH_KINDS.map((k) => healthPaths[k])

const COUNTER_PATHS = [
  paths.messagesTotal,
  paths.positionsClassA,
  paths.positionsClassB,
  paths.positionsOther,
  ...distanceBinPaths,
  ...HEALTH_PATHS,
]
const HEALTH_AT = 4 + DISTANCE_BIN_COUNT

const healthRecord = (values: number[]): Record<HealthKind, number> =>
  Object.fromEntries(HEALTH_KINDS.map((k, i) => [k, values[i] ?? 0])) as Record<
    HealthKind,
    number
  >

function sum(xs: number[]): number {
  let n = 0
  for (const x of xs) n += x
  return n
}

function maxOf(xs: (number | null)[]): number | undefined {
  let m: number | undefined
  for (const x of xs) if (x !== null && (m === undefined || x > m)) m = x
  return m
}

/**
 * Per-bucket increments of counters, from their `last` and `max` series.
 * The range starts one bucket early so the first bucket has a baseline.
 */
async function counterIncrements(
  h: HistoryReader,
  counterPaths: string[],
  from: number,
  to: number,
  res: number,
): Promise<{ times: number[]; increments: number[][] }> {
  const start = from - res * 1000
  const [last, max] = await Promise.all([
    h.series(counterPaths, 'last', start, to, res),
    h.series(counterPaths, 'max', start, to, res),
  ])
  // Align max on the times of last; providers answer the same buckets.
  const index = new Map(max.times.map((t, i) => [t, i]))
  return {
    times: last.times,
    increments: last.values.map((col, c) =>
      increments(
        col,
        last.times.map((t) => {
          const i = index.get(t)
          return i === undefined ? null : (max.values[c]?.[i] ?? null)
        }),
      ),
    ),
  }
}

interface Accumulator {
  counts: number[]
  /** Nautical miles. */
  p99: (number | undefined)[]
  max: number[]
  maxAt: (number | undefined)[]
  maxHour: (number | undefined)[]
  raise: (s: number, v: number | undefined | null) => void
  raiseMax: (
    s: number,
    nm: number,
    at: number | undefined,
    hour: number | undefined,
  ) => void
}

/**
 * Adds one hour bucket's sector counts and maxima, and its p99s where not
 * sparse.
 */
function addHour(b: Bucket, classIndexes: number[], a: Accumulator): void {
  const bp = sectorP99(b)
  for (const c of classIndexes)
    for (let s = 0; s < SECTOR_COUNT; s++) {
      const n = b.sectorCounts[c]![s]!
      a.counts[s]! += n
      if (n >= MIN_SECTOR_REPORTS) a.raise(s, bp[c]![s])
      a.raiseMax(
        s,
        b.sectorMaxNm[c]![s]!,
        b.sectorMaxAt[c]![s]! || undefined,
        undefined,
      )
    }
}

export class Query {
  constructor(
    private readonly agg: Aggregator,
    private readonly history: () => HistoryReader,
    /** The publish interval: history has nothing finer to offer. */
    private readonly minResolution = 60,
    private readonly onHistoryError: (err: unknown) => void = () => {},
    /** Long-range log entries in a time range, for exact maximum times. */
    private readonly longRange?: (
      from: number,
      to: number,
    ) => Promise<LongRangeEntry[]>,
    /** The configured weather paths (SPEC 9). */
    private readonly weatherPaths: () => string[] = () => [],
  ) {}

  /**
   * Hourly averages unless a provider rejected them once; then `last`
   * until the plugin restarts.
   */
  private weatherAggregate: Aggregate = 'average'

  private useHistory(windowMs: number, now: number): boolean {
    if (!this.history().available) return false
    // The live minute buckets are exact for the last hour once the plugin
    // has been running that long.
    return !(windowMs <= HOUR_MS && now - this.agg.startedAt >= HOUR_MS)
  }

  private resolution(seconds: number): number {
    return Math.max(seconds, this.minResolution)
  }

  /** Runs a history read, falling back to the live figures if it fails. */
  private async withFallback<T extends object>(
    fromHistory: () => Promise<T>,
    live: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await fromHistory()
    } catch (err) {
      this.onHistoryError(err)
      return { ...(await live()), historyError: HISTORY_FAILED }
    }
  }

  async summary(window: WindowName, now: number): Promise<Summary> {
    const w = WINDOWS[window]
    const from = now - w.ms
    const vessels = w.ms <= DAY_MS ? this.agg.uniqueVessels(now, w.ms) : null
    const base = {
      window,
      from: new Date(from).toISOString(),
      to: new Date(now).toISOString(),
      vessels,
    }

    const live = (): Summary => {
      const b = this.liveBucket(w.ms, now)
      return {
        ...base,
        source: 'live',
        messages: b.messages,
        positions: {
          classA: b.positions.A,
          classB: b.positions.B,
          other: b.positions.other,
        },
        distance: distanceFigures(b.distanceBins, b.maxNm),
        health: healthFigures(b.messages, { ...b.health }),
      }
    }
    if (!this.useHistory(w.ms, now)) return live()

    return this.withFallback(async (): Promise<Summary> => {
      const h = this.history()
      const res = this.resolution(w.resolution)
      const [counters, max] = await Promise.all([
        counterIncrements(h, COUNTER_PATHS, from, now, res),
        h.series([paths.distanceMax], 'max', from, now, w.ms / 1000),
      ])
      const totals = counters.increments.map(sum)
      return {
        ...base,
        source: 'history',
        messages: totals[0] ?? 0,
        positions: {
          classA: totals[1] ?? 0,
          classB: totals[2] ?? 0,
          other: totals[3] ?? 0,
        },
        distance: distanceFigures(
          totals.slice(4, HEALTH_AT),
          toNm(maxOf(max.values[0] ?? [])),
        ),
        health: healthFigures(
          totals[0] ?? 0,
          healthRecord(totals.slice(HEALTH_AT)),
        ),
      }
    }, live)
  }

  async sectors(
    window: WindowName,
    cls: SectorClass | 'all',
    now: number,
  ): Promise<SectorStats> {
    const w = WINDOWS[window]
    const classes = cls === 'all' ? [...SECTOR_CLASSES] : [cls]
    const iso = (t: number | undefined) =>
      t === undefined ? null : new Date(t).toISOString()
    const result = async (
      source: Source,
      a: Accumulator,
    ): Promise<SectorStats> => {
      const sectors: SectorStat[] = a.counts.map((count, s) => ({
        sector: s,
        fromDeg: s * SECTOR_WIDTH_DEG,
        toDeg: (s + 1) * SECTOR_WIDTH_DEG,
        count,
        p99M: metres(a.p99[s]),
        maxM: a.max[s]! > 0 ? Math.round(a.max[s]! * M_PER_NM) : null,
        maxAt: iso(a.maxAt[s]),
        maxHour: a.maxAt[s] === undefined ? iso(a.maxHour[s]) : null,
      }))
      // A maximum known only to the hour gets its time from the log.
      if (this.longRange && sectors.some((s) => s.maxHour !== null)) {
        const log = await this.longRange(now - w.ms, now + 1).catch(() => [])
        for (const s of sectors) {
          if (s.maxHour === null || s.maxM === null) continue
          const hit = log.find(
            (e) =>
              Math.abs(e.distanceM - s.maxM!) <= 1 &&
              sectorOf(e.bearingDeg) === s.sector &&
              classes.some((c) => c.toUpperCase() === e.cls),
          )
          if (hit) {
            s.maxAt = hit.time
            s.maxHour = null
          }
        }
      }
      return { window, class: cls, source, sectors }
    }
    const accumulator = (): Accumulator => {
      const a: Accumulator = {
        counts: new Array<number>(SECTOR_COUNT).fill(0),
        p99: new Array(SECTOR_COUNT).fill(undefined),
        max: new Array<number>(SECTOR_COUNT).fill(0),
        maxAt: new Array(SECTOR_COUNT).fill(undefined),
        maxHour: new Array(SECTOR_COUNT).fill(undefined),
        raise: (s, v) => {
          if (
            v !== undefined &&
            v !== null &&
            (a.p99[s] === undefined || v > a.p99[s]!)
          )
            a.p99[s] = v
        },
        raiseMax: (s, nm, at, hour) => {
          if (!(nm > a.max[s]!)) return
          a.max[s] = nm
          a.maxAt[s] = at
          a.maxHour[s] = hour
        },
      }
      return a
    }

    const live = (): Promise<SectorStats> => {
      const a = accumulator()
      const ci = classes.map((c) => SECTOR_CLASSES.indexOf(c))
      const buckets =
        w.ms <= HOUR_MS
          ? [this.agg.lastHour(now)]
          : this.agg
              .hourBuckets(now)
              .filter((b) => b.start + HOUR_MS > now - w.ms)
      for (const b of buckets) addHour(b, ci, a)
      return result('live', a)
    }
    if (!this.useHistory(w.ms, now)) return live()

    return this.withFallback(async () => {
      const a = accumulator()
      const { counts, raise } = a
      const h = this.history()
      const countPaths: string[] = []
      const p99Paths: string[] = []
      const maxPaths: string[] = []
      for (const c of classes)
        for (let s = 0; s < SECTOR_COUNT; s++) {
          countPaths.push(paths.sectorCount(s, c))
          p99Paths.push(paths.sectorP99(s, c))
          maxPaths.push(paths.sectorMax(s, c))
        }
      // The sector paths are published once an hour, at its end, so history
      // holds the closed hours and the open hour comes from the live bucket.
      const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS
      const from = Math.min(hourStart - HOUR_MS, hourStart - w.ms + HOUR_MS)
      const res = Math.max(HOUR_MS / 1000, this.resolution(w.resolution))
      // Hourly counts and p99s, so sparse hours can be left out of the p99.
      const [cs, ps, ms] = await Promise.all([
        counterIncrements(h, countPaths, from, hourStart, res),
        h.series(p99Paths, 'max', from, hourStart, res),
        h.series(maxPaths, 'max', from, hourStart, res),
      ])
      ms.values.forEach((col, i) =>
        col.forEach((v, k) => {
          // A value published at the end of an hour covers that hour.
          const t = ms.times[k]!
          if (v !== null)
            a.raiseMax(i % SECTOR_COUNT, v / M_PER_NM, undefined, t)
        }),
      )
      const p99At = new Map(ps.times.map((t, i) => [t, i]))
      const hours = cs.times.slice(1)
      cs.increments.forEach((col, i) => {
        const s = i % SECTOR_COUNT
        col.forEach((n, k) => {
          counts[s]! += n
          if (n < MIN_SECTOR_REPORTS) return
          const j = p99At.get(hours[k]!)
          if (j !== undefined) raise(s, toNm(ps.values[i]?.[j] ?? null))
        })
      })
      const open = this.agg.hourBuckets(now).find((b) => b.start === hourStart)
      if (open)
        addHour(
          open,
          classes.map((k) => SECTOR_CLASSES.indexOf(k)),
          a,
        )
      return result('history', a)
    }, live)
  }

  async series(
    metric: Metric,
    resolution: number,
    from: number,
    to: number,
  ): Promise<SeriesResult> {
    const live = () => this.liveSeries(metric, resolution, from, to)
    // Within the last hour the live minute buckets are finer than history.
    if (!this.useHistory(to - from, to)) return live()
    const res = this.resolution(resolution)
    // Buckets follow the start of the range, so start on a whole multiple
    // of the resolution: hourly bars then begin on the hour.
    const step = res * 1000
    const start = Math.floor(from / step) * step
    return this.withFallback(
      () => this.historySeries(metric, res, start, to),
      live,
    )
  }

  /**
   * The weather paths over a range, hourly. Read with `average`, retried
   * once with `last` if the provider rejects that. Nothing is held live,
   * so without history or after a failed read there is no weather.
   */
  async weather(from: number, to: number): Promise<WeatherResult> {
    const base = {
      resolution: WEATHER_RESOLUTION,
      aggregate: this.weatherAggregate,
      times: [] as string[],
      series: [] as WeatherSeries[],
    }
    const h = this.history()
    const wanted = this.weatherPaths()
    if (!h.available) return { ...base, available: false }
    if (wanted.length === 0) return { ...base, available: true }
    // Hour buckets that start on the hour, matching the distance series.
    const step = WEATHER_RESOLUTION * 1000
    const start = Math.floor(from / step) * step
    const read = (a: Aggregate) =>
      h.series(wanted, a, start, to, WEATHER_RESOLUTION)
    let s
    try {
      try {
        s = await read(this.weatherAggregate)
      } catch (err) {
        if (this.weatherAggregate !== 'average') throw err
        s = await read('last')
        this.weatherAggregate = 'last'
        this.onHistoryError(err)
      }
    } catch (err) {
      this.onHistoryError(err)
      return { ...base, available: true, historyError: WEATHER_FAILED }
    }
    return {
      ...base,
      available: true,
      aggregate: this.weatherAggregate,
      times: s.times.map((t) => new Date(t).toISOString()),
      series: wanted
        .map((path, i) => ({ path, values: s.values[i] ?? [] }))
        .filter((w) => w.values.some((v) => v !== null)),
    }
  }

  private liveBucket(windowMs: number, now: number): Bucket {
    if (windowMs <= HOUR_MS) return this.agg.lastHour(now)
    const out = emptyBucket(now - windowMs)
    for (const b of this.agg.hourBuckets(now))
      if (b.start + HOUR_MS > now - windowMs) mergeInto(out, b)
    return out
  }

  private async historySeries(
    metric: Metric,
    res: number,
    from: number,
    to: number,
  ): Promise<SeriesResult> {
    const h = this.history()
    const base = { metric, source: 'history' as const, resolution: res }
    if (metric === 'vessels') {
      const path =
        res >= DAY_MS / 1000 ? paths.vesselsLast24h : paths.vesselsLast1h
      const s = await h.series([path], 'last', from, to, res)
      return {
        ...base,
        times: s.times.map((t) => new Date(t).toISOString()),
        vessels: s.values[0] ?? [],
      }
    }
    const counterPaths =
      metric === 'messages'
        ? [paths.messagesTotal]
        : metric === 'positions'
          ? [paths.positionsClassA, paths.positionsClassB, paths.positionsOther]
          : metric === 'health'
            ? [paths.messagesTotal, ...HEALTH_PATHS]
            : distanceBinPaths
    const s = await counterIncrements(h, counterPaths, from, to, res)
    const inc = s.increments
    const times = s.times.slice(1).map((t) => new Date(t).toISOString())
    if (metric === 'messages') return { ...base, times, messages: inc[0] ?? [] }
    if (metric === 'health')
      return {
        ...base,
        times,
        ...healthColumns(
          times.map((_, i) => ({
            messages: inc[0]?.[i] ?? 0,
            health: healthRecord(inc.slice(1).map((col) => col[i] ?? 0)),
          })),
        ),
      }
    if (metric === 'positions')
      return {
        ...base,
        times,
        classA: inc[0] ?? [],
        classB: inc[1] ?? [],
        other: inc[2] ?? [],
      }
    const max = await h.series([paths.distanceMax], 'max', from, to, res)
    const maxAt = new Map(
      max.times.map((t, i) => [t, max.values[0]?.[i] ?? null]),
    )
    const cols = distanceColumns(
      times.map((_, i) => inc.map((col) => col[i] ?? 0)),
    )
    return {
      ...base,
      times,
      ...cols,
      maxM: s.times.slice(1).map((t) => {
        const v = maxAt.get(t)
        return v === undefined || v === null ? null : Math.round(v)
      }),
    }
  }

  private liveSeries(
    metric: Metric,
    res: number,
    from: number,
    to: number,
  ): SeriesResult {
    const now = to
    const step = res < 3600 ? MINUTE_MS : HOUR_MS
    const raw =
      step === MINUTE_MS
        ? this.agg.minuteBuckets(now)
        : this.agg.hourBuckets(now)
    // Merge the live buckets into buckets of the requested resolution.
    const size = Math.max(step, Math.round((res * 1000) / step) * step)
    const merged = new Map<number, Bucket>()
    for (const b of raw) {
      if (b.start + step <= from || b.start >= to) continue
      const key = Math.floor(b.start / size) * size
      let m = merged.get(key)
      if (!m) {
        m = emptyBucket(key)
        merged.set(key, m)
      }
      mergeInto(m, b)
      m.vessels = Math.max(m.vessels, b.vessels)
    }
    const buckets = [...merged.values()].sort((a, b) => a.start - b.start)
    const base = {
      metric,
      source: 'live' as const,
      resolution: size / 1000,
      times: buckets.map((b) => new Date(b.start).toISOString()),
    }
    switch (metric) {
      case 'messages':
        return { ...base, messages: buckets.map((b) => b.messages) }
      case 'positions':
        return {
          ...base,
          classA: buckets.map((b) => b.positions.A),
          classB: buckets.map((b) => b.positions.B),
          other: buckets.map((b) => b.positions.other),
        }
      case 'vessels':
        return { ...base, vessels: buckets.map((b) => b.vessels) }
      case 'health':
        return { ...base, ...healthColumns(buckets) }
      case 'distance':
        return {
          ...base,
          ...distanceColumns(buckets.map((b) => b.distanceBins)),
          maxM: buckets.map((b) => metres(b.maxNm)),
        }
    }
  }
}

/**
 * Health columns of a series: `received` (the share denominator) and one
 * count column per health kind.
 */
function healthColumns(
  rows: { messages: number; health: Record<HealthKind, number> }[],
): { received: number[] } & Record<HealthKind, number[]> {
  const f = rows.map((r) => healthFigures(r.messages, r.health))
  return {
    received: f.map((x) => x.received),
    ...(Object.fromEntries(
      HEALTH_KINDS.map((k) => [k, f.map((x) => x.counts[k])]),
    ) as Record<HealthKind, number[]>),
  }
}

function distanceColumns(rows: number[][]) {
  const f = rows.map((bins) => {
    const b = emptyBins(DISTANCE_BIN_COUNT)
    addInto(b, bins)
    return distanceFigures(b)
  })
  return {
    count: f.map((x) => x.count),
    avgM: f.map((x) => x.avgM),
    medianM: f.map((x) => x.medianM),
    p95M: f.map((x) => x.p95M),
    p99M: f.map((x) => x.p99M),
  }
}
