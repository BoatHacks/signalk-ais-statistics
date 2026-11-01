// Fixed log-spaced distance histogram (SPEC 2.3). The bin layout is part of
// the persistence schema: bin nn of `distance.bin.nn` always means the same
// distance range, so do not change it without migrating readers.
//
// Bin 0 covers [0, 0.5) nm. Bins 1 to 30 split [0.5, 512) nm into steps of
// 2^(1/3), about 26 percent wide. Bin 31 is the overflow bin, 512 nm and
// beyond, where bogus positions land.
import { DISTANCE_BIN_COUNT } from './paths'

export const FIRST_EDGE_NM = 0.5
export const STEPS_PER_DOUBLING = 3
export const OVERFLOW_NM =
  FIRST_EDGE_NM * 2 ** ((DISTANCE_BIN_COUNT - 2) / STEPS_PER_DOUBLING)

/** Coarse sector histograms merge pairs of distance bins. */
export const SECTOR_BIN_COUNT = DISTANCE_BIN_COUNT / 2

export function emptyBins(n = DISTANCE_BIN_COUNT): number[] {
  return new Array<number>(n).fill(0)
}

export function binOf(nm: number): number {
  if (!(nm >= FIRST_EDGE_NM)) return 0
  let i = 1 + Math.floor(STEPS_PER_DOUBLING * Math.log2(nm / FIRST_EDGE_NM))
  // The logarithm can round a distance on an edge into the bin below; the
  // edges themselves decide.
  if (i < DISTANCE_BIN_COUNT - 1 && nm >= binLowerNm(i + 1)) i++
  else if (i > 1 && nm < binLowerNm(i)) i--
  return Math.min(DISTANCE_BIN_COUNT - 1, i)
}

export function binLowerNm(bin: number): number {
  if (bin <= 0) return 0
  return FIRST_EDGE_NM * 2 ** ((bin - 1) / STEPS_PER_DOUBLING)
}

export function binUpperNm(bin: number): number {
  if (bin >= DISTANCE_BIN_COUNT - 1) return Infinity
  return binLowerNm(bin + 1)
}

export const sectorBinOf = (nm: number): number => Math.floor(binOf(nm) / 2)
const sectorLower = (k: number) => binLowerNm(2 * k)
const sectorUpper = (k: number) => binUpperNm(2 * k + 1)

export function total(bins: readonly number[]): number {
  let n = 0
  for (const c of bins) n += c
  return n
}

export function addInto(target: number[], source: readonly number[]): void {
  for (let i = 0; i < target.length; i++) target[i]! += source[i] ?? 0
}

function interpolate(lo: number, hi: number, frac: number): number {
  if (!Number.isFinite(hi)) return lo
  if (lo <= 0) return hi * frac
  return lo * (hi / lo) ** frac
}

function percentileWith(
  bins: readonly number[],
  q: number,
  lower: (i: number) => number,
  upper: (i: number) => number,
): number | undefined {
  const n = total(bins)
  if (n <= 0) return undefined
  const target = Math.min(1, Math.max(0, q)) * n
  let cum = 0
  for (let i = 0; i < bins.length; i++) {
    const c = bins[i]!
    if (c <= 0) continue
    if (cum + c >= target) {
      return interpolate(lower(i), upper(i), (target - cum) / c)
    }
    cum += c
  }
  return lower(bins.length - 1)
}

/**
 * Percentile q (0 to 1) of a distance histogram, interpolated within the
 * bin, so it is exact to the bin width. The overflow bin reports its lower
 * edge. Undefined when the histogram is empty.
 */
export function percentileNm(
  bins: readonly number[],
  q: number,
): number | undefined {
  return percentileWith(bins, q, binLowerNm, binUpperNm)
}

export function sectorPercentileNm(
  bins: readonly number[],
  q: number,
): number | undefined {
  return percentileWith(bins, q, sectorLower, sectorUpper)
}

/** Representative distance of a bin: geometric centre, or the overflow edge. */
export function binCentreNm(bin: number): number {
  if (bin <= 0) return FIRST_EDGE_NM / 2
  const hi = binUpperNm(bin)
  if (!Number.isFinite(hi)) return OVERFLOW_NM
  return Math.sqrt(binLowerNm(bin) * hi)
}

/** Average distance from the histogram, using bin centres. */
export function averageNm(bins: readonly number[]): number | undefined {
  const n = total(bins)
  if (n <= 0) return undefined
  let sum = 0
  for (let i = 0; i < bins.length; i++) sum += bins[i]! * binCentreNm(i)
  return sum / n
}

export interface DistanceSummary {
  count: number
  avgNm?: number
  medianNm?: number
  p95Nm?: number
  p99Nm?: number
}

/**
 * Distance figures of a histogram. Interpolation within a bin can land above
 * the largest distance actually seen, so when the measured maximum is known
 * every figure is capped at it.
 */
export function summarize(
  bins: readonly number[],
  maxNm?: number,
): DistanceSummary {
  const cap = (v: number | undefined) =>
    v !== undefined && maxNm !== undefined ? Math.min(v, maxNm) : v
  return {
    count: total(bins),
    avgNm: cap(averageNm(bins)),
    medianNm: cap(percentileNm(bins, 0.5)),
    p95Nm: cap(percentileNm(bins, 0.95)),
    p99Nm: cap(percentileNm(bins, 0.99)),
  }
}
