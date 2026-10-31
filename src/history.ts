// The only component that reads history (ARCHITECTURE 2.7). It goes through
// the SignalK History API of the server's default provider and uses only
// the `last` and `max` aggregates that every provider is expected to have.
import { Temporal } from '@js-temporal/polyfill'
import type { Path } from '@signalk/server-api'
import type { HistoryApi } from '@signalk/server-api/history'

export type Aggregate = 'last' | 'max'

export interface Series {
  /** Bucket timestamps in milliseconds, ascending. */
  times: number[]
  /** One array per requested path, aligned with `times`; null where the provider had nothing. */
  values: (number | null)[][]
}

export interface HistoryReader {
  readonly available: boolean
  series(
    paths: string[],
    aggregate: Aggregate,
    from: number,
    to: number,
    resolutionSeconds: number,
  ): Promise<Series>
}

/** Live-only mode: no provider registered or it does not answer. */
export const nullHistoryReader: HistoryReader = {
  available: false,
  async series() {
    return { times: [], values: [] }
  },
}

/** Paths per request; keeps query strings and provider work small. */
const CHUNK = 40

export class HistoryApiReader implements HistoryReader {
  readonly available = true
  /**
   * Requests run one at a time, across all callers. Providers such as
   * signalk-questdb run one database query per path, and parallel requests
   * multiplied that into enough concurrent scans to exhaust the database's
   * memory on a busy server.
   */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly api: HistoryApi) {}

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => undefined)
    return run
  }

  async series(
    paths: string[],
    aggregate: Aggregate,
    from: number,
    to: number,
    resolutionSeconds: number,
  ): Promise<Series> {
    const chunks: string[][] = []
    for (let i = 0; i < paths.length; i += CHUNK)
      chunks.push(paths.slice(i, i + CHUNK))
    const parts: Series[] = []
    for (const c of chunks)
      parts.push(
        await this.enqueue(() =>
          this.query(c, aggregate, from, to, resolutionSeconds),
        ),
      )
    return mergeSeries(parts)
  }

  private async query(
    paths: string[],
    aggregate: Aggregate,
    from: number,
    to: number,
    resolution: number,
  ): Promise<Series> {
    const res = await this.api.getValues({
      from: Temporal.Instant.fromEpochMilliseconds(from),
      to: Temporal.Instant.fromEpochMilliseconds(to),
      // A resolution is required: without one the provider returned no rows.
      resolution,
      pathSpecs: paths.map((path) => ({
        path: path as Path,
        aggregate,
        parameter: [],
      })),
    })
    return parseRows(res.data, paths.length)
  }
}

export function parseRows(rows: unknown[][], width: number): Series {
  const times: number[] = []
  const values: (number | null)[][] = Array.from({ length: width }, () => [])
  for (const row of rows) {
    const t = Date.parse(String(row[0]))
    if (!Number.isFinite(t)) continue
    times.push(t)
    for (let i = 0; i < width; i++) {
      const v = row[i + 1]
      values[i]!.push(typeof v === 'number' && Number.isFinite(v) ? v : null)
    }
  }
  return { times, values }
}

/** Joins series queried in chunks over the same range, aligning on time. */
export function mergeSeries(parts: Series[]): Series {
  if (parts.length === 1) return parts[0]!
  const allTimes = [...new Set(parts.flatMap((p) => p.times))].sort(
    (a, b) => a - b,
  )
  const values: (number | null)[][] = []
  for (const p of parts) {
    const index = new Map(p.times.map((t, i) => [t, i]))
    for (const col of p.values)
      values.push(
        allTimes.map((t) => {
          const i = index.get(t)
          return i === undefined ? null : (col[i] ?? null)
        }),
      )
  }
  return { times: allTimes, values }
}

/**
 * Turns a `last` series of a cumulative counter into per-bucket increments.
 * The first bucket is the baseline and gets no increment. A null before the
 * first sample counts as zero, a null later as unchanged, and a value lower
 * than its predecessor means the counter restarted from zero (SPEC 6.2).
 *
 * With the `max` series of the same buckets, a restart inside a bucket also
 * counts what the old counter reached in that bucket before it restarted:
 * the bucket's max minus the previous last, plus the new last.
 */
export function increments(
  last: (number | null)[],
  max?: (number | null)[],
): number[] {
  const out: number[] = []
  let prev: number | undefined
  for (let i = 0; i < last.length; i++) {
    const v = last[i] ?? prev ?? 0
    if (i > 0) {
      const p = prev ?? 0
      if (v >= p) out.push(v - p)
      else {
        const m = max?.[i]
        out.push((m !== null && m !== undefined && m > p ? m - p : 0) + v)
      }
    }
    prev = v
  }
  return out
}

/** Obtains a reader for the server's default provider, or the null reader. */
export async function connectHistory(app: {
  getHistoryApi?: (id?: string) => Promise<HistoryApi>
}): Promise<HistoryReader> {
  if (!app.getHistoryApi) return nullHistoryReader
  try {
    return new HistoryApiReader(await app.getHistoryApi())
  } catch {
    return nullHistoryReader
  }
}
