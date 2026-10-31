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
import { increments, type HistoryReader } from './history'
import { addInto, emptyBins, summarize } from './histogram'
import {
  DISTANCE_BIN_COUNT,
  SECTOR_CLASSES,
  SECTOR_COUNT,
  SECTOR_WIDTH_DEG,
  distanceBinPaths,
  paths,
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

export const METRICS = ['messages', 'positions', 'distance', 'vessels'] as const
export type Metric = (typeof METRICS)[number]
export const MAX_SERIES_POINTS = 2000

export type Source = 'history' | 'live'

/**
 * Shown instead of the provider's own error, which can be a long database
 * message; the full error goes to the server log.
 */
export const HISTORY_FAILED =
  'The history provider could not answer, so these figures are live data from at most the last 24 hours.'

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
  /** Set when history failed and the figures fell back to live data. */
  historyError?: string
}

export interface RadarSector {
  sector: number
  fromDeg: number
  toDeg: number
  count: number
  p99M: number | null
}

export interface Radar {
  window: WindowName
  class: SectorClass | 'all'
  source: Source
  sectors: RadarSector[]
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

const COUNTER_PATHS = [
  paths.messagesTotal,
  paths.positionsClassA,
  paths.positionsClassB,
  paths.positionsOther,
  ...distanceBinPaths,
]

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

export class Query {
  constructor(
    private readonly agg: Aggregator,
    private readonly history: () => HistoryReader,
    /** The publish interval: history has nothing finer to offer. */
    private readonly minResolution = 60,
    private readonly onHistoryError: (err: unknown) => void = () => {},
  ) {}

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
    live: () => T,
  ): Promise<T> {
    try {
      return await fromHistory()
    } catch (err) {
      this.onHistoryError(err)
      return { ...live(), historyError: HISTORY_FAILED }
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
          totals.slice(4),
          toNm(maxOf(max.values[0] ?? [])),
        ),
      }
    }, live)
  }

  async radar(
    window: WindowName,
    cls: SectorClass | 'all',
    now: number,
  ): Promise<Radar> {
    const w = WINDOWS[window]
    const classes = cls === 'all' ? [...SECTOR_CLASSES] : [cls]
    const result = (
      source: Source,
      counts: number[],
      p99: (number | undefined)[],
    ): Radar => ({
      window,
      class: cls,
      source,
      sectors: counts.map((count, s) => ({
        sector: s,
        fromDeg: s * SECTOR_WIDTH_DEG,
        toDeg: (s + 1) * SECTOR_WIDTH_DEG,
        count,
        p99M: metres(p99[s]),
      })),
    })
    const accumulator = () => {
      const counts = new Array<number>(SECTOR_COUNT).fill(0)
      const p99: (number | undefined)[] = new Array(SECTOR_COUNT).fill(
        undefined,
      )
      const raise = (s: number, v: number | undefined | null) => {
        if (
          v !== undefined &&
          v !== null &&
          (p99[s] === undefined || v > p99[s]!)
        )
          p99[s] = v
      }
      return { counts, p99, raise }
    }

    const live = (): Radar => {
      const { counts, p99, raise } = accumulator()
      const ci = classes.map((c) => SECTOR_CLASSES.indexOf(c))
      const buckets =
        w.ms <= HOUR_MS
          ? [this.agg.lastHour(now)]
          : this.agg
              .hourBuckets(now)
              .filter((b) => b.start + HOUR_MS > now - w.ms)
      for (const b of buckets) {
        const bp = sectorP99(b)
        for (const c of ci)
          for (let s = 0; s < SECTOR_COUNT; s++) {
            counts[s]! += b.sectorCounts[c]![s]!
            raise(s, bp[c]![s])
          }
      }
      return result('live', counts, p99)
    }
    if (!this.useHistory(w.ms, now)) return live()

    return this.withFallback(async () => {
      const { counts, p99, raise } = accumulator()
      const h = this.history()
      const countPaths: string[] = []
      const p99Paths: string[] = []
      for (const c of classes)
        for (let s = 0; s < SECTOR_COUNT; s++) {
          countPaths.push(paths.sectorCount(s, c))
          p99Paths.push(paths.sectorP99(s, c))
        }
      const res = this.resolution(w.resolution)
      const [cs, ps] = await Promise.all([
        counterIncrements(h, countPaths, now - w.ms, now, res),
        h.series(p99Paths, 'max', now - w.ms, now, w.ms / 1000),
      ])
      cs.increments.forEach((col, i) => {
        counts[i % SECTOR_COUNT]! += sum(col)
      })
      ps.values.forEach((col, i) => raise(i % SECTOR_COUNT, toNm(maxOf(col))))
      return result('history', counts, p99)
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
    return this.withFallback(
      () => this.historySeries(metric, this.resolution(resolution), from, to),
      live,
    )
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
          : distanceBinPaths
    const s = await counterIncrements(h, counterPaths, from, to, res)
    const inc = s.increments
    const times = s.times.slice(1).map((t) => new Date(t).toISOString())
    if (metric === 'messages') return { ...base, times, messages: inc[0] ?? [] }
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
      case 'distance':
        return {
          ...base,
          ...distanceColumns(buckets.map((b) => b.distanceBins)),
          maxM: buckets.map((b) => metres(b.maxNm)),
        }
    }
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
