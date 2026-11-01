import { describe, expect, it } from 'vitest'
import { MIN_SECTOR_REPORTS } from '../../src/query'
import {
  MIN_HOUR_REPORTS,
  MIN_PAIRS,
  difference,
  pairHours,
  pearson,
  rightRange,
  type Pair,
} from '../../web/src/stats'

const H = 3_600_000
const pairs = (f: (i: number) => number, n = 30): Pair[] =>
  Array.from({ length: n }, (_, i) => ({ time: i * H, x: i, y: f(i) }))

describe('pearson', () => {
  it('is 1 and -1 for perfect linear relations', () => {
    expect(pearson(pairs((i) => 3 * i + 2))).toBeCloseTo(1, 12)
    expect(pearson(pairs((i) => 100 - i))).toBeCloseTo(-1, 12)
  })

  it('matches a known value', () => {
    // x 0..29, y alternating around a slope: r of a hand-checked set.
    const p = pairs((i) => i + (i % 2 === 0 ? 5 : -5))
    const r = pearson(p)!
    expect(r).toBeGreaterThan(0.8)
    expect(r).toBeLessThan(0.9)
  })

  it('gives no r for a constant side or too few pairs', () => {
    expect(pearson(pairs(() => 7))).toBeNull()
    expect(pearson(pairs((i) => i, MIN_PAIRS - 1))).toBeNull()
    expect(pearson(pairs((i) => i, MIN_PAIRS))).toBeCloseTo(1, 12)
  })
})

describe('pairHours', () => {
  it('pairs by hour start and skips missing values and sparse hours', () => {
    const range = {
      times: [0, H, 2 * H, 3 * H, 4 * H],
      p99: [10, null, 30, 40, 50],
      count: [20, 50, 50, 19, 100],
    }
    const weather = {
      times: [H, 2 * H, 3 * H, 4 * H, 5 * H],
      values: [1, 2, 3, null, 5],
    }
    // 0: no weather; H: no p99; 3H: 19 reports; 4H: no weather value.
    expect(pairHours(range, weather)).toEqual([{ time: 2 * H, x: 2, y: 30 }])
  })

  it('uses the same report minimum as the sectors', () => {
    expect(MIN_HOUR_REPORTS).toBe(MIN_SECTOR_REPORTS)
  })
})

describe('difference', () => {
  it('subtracts element-wise, null where either is missing', () => {
    expect(difference([3, null, 5, 1], [1, 2, null, 4])).toEqual([
      2,
      null,
      null,
      -3,
    ])
  })
})

describe('rightRange', () => {
  it('spans the data with padding, not from zero', () => {
    const r = rightRange([[101000, null, 102000]])
    expect(r.min).toBeCloseTo(100950)
    expect(r.max).toBeCloseTo(102050)
  })

  it('never collapses to an empty span', () => {
    const r = rightRange([[5, 5]])
    expect(r.max).toBeGreaterThan(r.min)
    expect(rightRange([[null]])).toEqual({ min: 0, max: 1 })
  })
})
