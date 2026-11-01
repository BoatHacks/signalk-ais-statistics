import { describe, expect, it } from 'vitest'
import type { SectorStats } from '../../web/src/api'
import { TICK_ROOM, sectorLayout } from '../../web/src/ticks'

const RIM = 100

function stats(sectors: [number | null, number | null][]): SectorStats {
  return {
    window: '1h',
    class: 'a',
    source: 'live',
    sectors: Array.from({ length: 24 }, (_, i) => {
      const [p99M, maxM] = sectors[i] ?? [null, null]
      return {
        sector: i,
        fromDeg: i * 15,
        toDeg: (i + 1) * 15,
        count: maxM === null ? 0 : 50,
        p99M,
        maxM,
        maxAt: null,
        maxHour: null,
      }
    }),
  } as SectorStats
}

describe('sectorLayout', () => {
  it('gives every sector with a reception a tick, also one at its wedge', () => {
    // Sector 4: farthest reception at the wedge's edge, as after the p99 cap.
    const { ticks } = sectorLayout(
      stats([
        [10_000, 20_000],
        [null, null],
        [null, 5_000],
        [null, null],
        [40_000, 40_000],
      ]),
      RIM,
    )
    expect(ticks[0]).not.toBeNull()
    expect(ticks[1]).toBeNull()
    expect(ticks[2]!.wedge).toBe(0)
    expect(ticks[4]!.outer).toBe(ticks[4]!.wedge)
    expect(ticks[4]!.outer).toBeGreaterThan(0)
  })

  it('marks only the farthest reception of the chart', () => {
    const { ticks } = sectorLayout(
      stats([
        [10_000, 20_000],
        [10_000, 30_000],
        [10_000, 30_000],
      ]),
      RIM,
    )
    expect(ticks.map((t) => t?.farthest ?? false).filter(Boolean)).toHaveLength(
      1,
    )
    expect(ticks[1]!.farthest).toBe(true)
    expect(ticks[0]!.farthest).toBe(false)
  })

  it('stops ticks beyond the scale at the rim', () => {
    const { max, ticks } = sectorLayout(
      stats([
        [10_000, 12_000],
        [10_000, 1_000_000],
      ]),
      RIM,
    )
    expect(max).toBe(10_000 * TICK_ROOM)
    expect(ticks[1]).toMatchObject({
      outer: RIM,
      clipped: true,
      farthest: true,
    })
    expect(ticks[0]!.clipped).toBe(false)
    expect(ticks[0]!.outer).toBeCloseTo((12_000 / max) * RIM)
  })

  it('draws nothing without receptions', () => {
    const { max, ticks } = sectorLayout(stats([]), RIM)
    expect(max).toBe(0)
    expect(ticks.every((t) => t === null)).toBe(true)
  })
})
