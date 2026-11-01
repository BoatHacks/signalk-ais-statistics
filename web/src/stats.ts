// Pairing of hourly range with weather and their correlation, for the
// range vs weather panel (SPEC 7). Pure functions, tested on their own.

/**
 * An hour joins the scatter and r only with at least this many distance
 * reports, the same minimum as for the sector distances: the p99 of a
 * handful of reports is chance (chosen by the maintainer). The time chart
 * still shows every hour.
 */
export const MIN_HOUR_REPORTS = 20

/** Fewer pairs than this give no r: a day of hours at least. */
export const MIN_PAIRS = 24

export interface Pair {
  time: number
  /** The weather value, x on the scatter. */
  x: number
  /** The hour's p99 range, y on the scatter. */
  y: number
}

/**
 * Pairs each hour's p99 with the weather value of the same hour start,
 * leaving out hours where either is missing or that have fewer than
 * MIN_HOUR_REPORTS reports.
 */
export function pairHours(
  range: { times: number[]; p99: (number | null)[]; count: number[] },
  weather: { times: number[]; values: (number | null)[] },
): Pair[] {
  const at = new Map(weather.times.map((t, i) => [t, weather.values[i]]))
  const out: Pair[] = []
  range.times.forEach((time, i) => {
    const y = range.p99[i]
    const x = at.get(time)
    if ((range.count[i] ?? 0) < MIN_HOUR_REPORTS) return
    if (y === null || y === undefined || x === null || x === undefined) return
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    out.push({ time, x, y })
  })
  return out
}

/**
 * Pearson's correlation coefficient of the pairs, or null with fewer than
 * MIN_PAIRS pairs or when either side does not vary.
 */
export function pearson(pairs: Pair[]): number | null {
  const n = pairs.length
  if (n < MIN_PAIRS) return null
  let mx = 0
  let my = 0
  for (const p of pairs) {
    mx += p.x
    my += p.y
  }
  mx /= n
  my /= n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const p of pairs) {
    const dx = p.x - mx
    const dy = p.y - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx === 0 || syy === 0) return null
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)))
}

/** Element-wise a minus b, null where either is missing. */
export function difference(
  a: (number | null)[],
  b: (number | null)[],
): (number | null)[] {
  return a.map((v, i) => {
    const w = b[i]
    return v === null || w === null || w === undefined ? null : v - w
  })
}

/** The span of the right axis: the data's range, padded, never empty. */
export function rightRange(values: (number | null)[][]): {
  min: number
  max: number
} {
  let min = Infinity
  let max = -Infinity
  for (const c of values)
    for (const v of c)
      if (v !== null && Number.isFinite(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
  if (min > max) return { min: 0, max: 1 }
  const pad = max > min ? (max - min) * 0.05 : Math.abs(max) * 0.01 || 1
  return { min: min - pad, max: max + pad }
}
