import { describe, expect, it } from 'vitest'
import {
  OVERFLOW_NM,
  addInto,
  averageNm,
  binLowerNm,
  binOf,
  binUpperNm,
  emptyBins,
  percentileNm,
  sectorBinOf,
  sectorPercentileNm,
  summarize,
  total,
} from '../src/histogram'
import { DISTANCE_BIN_COUNT } from '../src/paths'
import { distances, seeded } from './fixtures/random'

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

  it('never reports a figure above the measured maximum', () => {
    const s = summarize(histogramOf([10, 10, 10, 10.1]), 10.1)
    for (const v of [s.avgNm, s.medianNm, s.p95Nm, s.p99Nm])
      expect(v).toBeLessThanOrEqual(10.1)
  })

  it('averages with bin centres', () => {
    const avg = averageNm(histogramOf([10, 10, 10]))!
    expect(avg).toBeGreaterThan(binLowerNm(binOf(10)))
    expect(avg).toBeLessThan(binUpperNm(binOf(10)))
  })
})

describe('bin edges', () => {
  it('puts a distance exactly on an edge into the bin above it', () => {
    for (let b = 1; b < DISTANCE_BIN_COUNT; b++) {
      const edge = binLowerNm(b)
      expect(binOf(edge), `edge of bin ${b}`).toBe(b)
      expect(binOf(edge * (1 - 1e-12)), `just below bin ${b}`).toBe(b - 1)
    }
  })

  it('starts the overflow bin at 512 nm', () => {
    expect(binOf(511.999)).toBe(DISTANCE_BIN_COUNT - 2)
    expect(binOf(512)).toBe(DISTANCE_BIN_COUNT - 1)
    expect(binOf(Infinity)).toBe(DISTANCE_BIN_COUNT - 1)
  })
})

describe('histogram properties', () => {
  const QS = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999, 1]

  it('never lowers a percentile when q rises', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rand = seeded(seed)
      const bins = histogramOf(distances(rand, 1 + Math.floor(rand() * 500)))
      for (const pct of [percentileNm, sectorPercentileNm]) {
        const input = pct === percentileNm ? bins : pairs(bins)
        let prev = -Infinity
        for (const q of QS) {
          const v = pct(input, q)!
          expect(v, `seed ${seed}, q ${q}`).toBeGreaterThanOrEqual(prev)
          prev = v
        }
      }
    }
  })

  it('merges split histograms into the same result as one pass', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rand = seeded(seed)
      const values = distances(rand, 300)
      const merged = emptyBins()
      // Split into a random number of uneven parts, like hourly buckets.
      let start = 0
      while (start < values.length) {
        const end = start + 1 + Math.floor(rand() * 80)
        addInto(merged, histogramOf(values.slice(start, end)))
        start = end
      }
      const single = histogramOf(values)
      expect(merged).toEqual(single)
      for (const q of QS)
        expect(percentileNm(merged, q)).toBe(percentileNm(single, q))
    }
  })

  it('keeps every percentile inside the bins that hold data', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const values = distances(seeded(seed), 200)
      const bins = histogramOf(values)
      const lo = binLowerNm(binOf(Math.min(...values)))
      const hi = binLowerNm(binOf(Math.max(...values)) + 1)
      for (const q of QS) {
        const v = percentileNm(bins, q)!
        expect(v).toBeGreaterThanOrEqual(lo)
        expect(v).toBeLessThanOrEqual(hi)
      }
    }
  })

  it('counts every value once, overflow included', () => {
    const values = distances(seeded(7), 1000)
    expect(total(histogramOf(values))).toBe(1000)
    expect(summarize(histogramOf(values)).count).toBe(1000)
  })

  it('agrees with the exact percentile to the bin width', () => {
    // Bins are 2^(1/3) wide, so an interpolated percentile is within about
    // 26 percent of the exact one, away from bin 0 and the overflow bin.
    for (let seed = 1; seed <= 20; seed++) {
      const rand = seeded(seed)
      const values = Array.from({ length: 2000 }, () => 1 + rand() * 200).sort(
        (a, b) => a - b,
      )
      const bins = histogramOf(values)
      for (const q of [0.5, 0.95, 0.99]) {
        const exact = values[Math.ceil(q * values.length) - 1]!
        const p = percentileNm(bins, q)!
        expect(Math.abs(p - exact) / exact).toBeLessThan(0.26)
      }
    }
  })
})

/** Pairs distance bins into sector bins, as the aggregator does. */
function pairs(bins: number[]): number[] {
  return Array.from({ length: bins.length / 2 }, (_, k) => {
    return bins[2 * k]! + bins[2 * k + 1]!
  })
}
