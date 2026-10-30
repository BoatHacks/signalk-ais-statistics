import { describe, expect, it } from 'vitest'
import {
  OVERFLOW_NM,
  averageNm,
  binLowerNm,
  binOf,
  binUpperNm,
  emptyBins,
  percentileNm,
  sectorBinOf,
  summarize,
} from '../src/histogram'
import { DISTANCE_BIN_COUNT } from '../src/paths'

function histogramOf(values: number[]): number[] {
  const bins = emptyBins()
  for (const v of values) bins[binOf(v)]!++
  return bins
}

describe('distance bins', () => {
  it('has contiguous edges from 0 to the overflow bin', () => {
    expect(binLowerNm(0)).toBe(0)
    for (let i = 0; i < DISTANCE_BIN_COUNT - 1; i++)
      expect(binUpperNm(i)).toBeCloseTo(binLowerNm(i + 1), 9)
    expect(OVERFLOW_NM).toBeCloseTo(512, 9)
    expect(binUpperNm(DISTANCE_BIN_COUNT - 1)).toBe(Infinity)
  })

  it('places every distance inside its bin', () => {
    for (const d of [0, 0.1, 0.5, 0.63, 1, 7.3, 30, 100, 511.9, 512, 5000]) {
      const b = binOf(d)
      expect(d).toBeGreaterThanOrEqual(binLowerNm(b))
      expect(d).toBeLessThan(binUpperNm(b))
    }
  })

  it('maps nonsense distances to bin 0', () => {
    expect(binOf(Number.NaN)).toBe(0)
    expect(binOf(-1)).toBe(0)
  })

  it('pairs distance bins into 16 sector bins', () => {
    expect(sectorBinOf(0)).toBe(0)
    expect(sectorBinOf(10_000)).toBe(15)
  })
})

describe('percentiles', () => {
  it('is undefined for an empty histogram', () => {
    expect(percentileNm(emptyBins(), 0.5)).toBeUndefined()
    expect(averageNm(emptyBins())).toBeUndefined()
  })

  it('is exact to the bin width', () => {
    const values = Array.from({ length: 1000 }, (_, i) => 1 + (i * 49) / 999)
    const bins = histogramOf(values)
    for (const [q, exact] of [
      [0.5, values[499]!],
      [0.95, values[949]!],
      [0.99, values[989]!],
    ] as const) {
      const p = percentileNm(bins, q)!
      expect(Math.abs(p - exact) / exact).toBeLessThan(0.27)
    }
  })

  it('keeps p99 robust to a few bogus positions while max is not', () => {
    const values = [...Array.from({ length: 995 }, () => 20), 3000, 4000]
    const s = summarize(histogramOf(values))
    expect(s.p99Nm).toBeLessThan(26)
    expect(s.medianNm).toBeLessThan(26)
    expect(s.count).toBe(997)
  })

  it('reports the overflow edge when the percentile lands there', () => {
    expect(percentileNm(histogramOf([9000, 9000]), 0.5)).toBe(OVERFLOW_NM)
  })

  it('averages with bin centres', () => {
    const avg = averageNm(histogramOf([10, 10, 10]))!
    expect(avg).toBeGreaterThan(binLowerNm(binOf(10)))
    expect(avg).toBeLessThan(binUpperNm(binOf(10)))
  })
})
