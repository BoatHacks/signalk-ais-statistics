import { describe, expect, it } from 'vitest'
import type { SectorStats } from '../../web/src/api'
import { SCALE_ROOM, sectorLayout } from '../../web/src/sector-layout'

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
  it('puts one dot in the sector with the farthest reception', () => {
    const { max, farthest } = sectorLayout(
      stats([
        [10_000, 20_000],
        [null, null],
        [null, 5_000],
        [40_000, 40_000],
      ]),
      RIM,
    )
    expect(max).toBe(40_000)
    expect(farthest).toEqual({ sector: 3, r: RIM, clipped: false })
  })

  it('takes the first sector when two tie', () => {
    const { farthest } = sectorLayout(
      stats([
        [10_000, 11_000],
        [10_000, 12_000],
        [10_000, 12_000],
      ]),
      RIM,
    )
    expect(farthest!.sector).toBe(1)
    expect(farthest!.r).toBe(RIM)
  })

  it('puts a farthest reception beyond the scale on the rim', () => {
    const { max, farthest } = sectorLayout(
      stats([
        [10_000, 12_000],
        [10_000, 1_000_000],
      ]),
      RIM,
    )
    expect(max).toBe(10_000 * SCALE_ROOM)
    expect(farthest).toEqual({ sector: 1, r: RIM, clipped: true })
  })

  it('follows a shared scale', () => {
    const { max, farthest } = sectorLayout(
      stats([[10_000, 10_000]]),
      RIM,
      20_000,
    )
    expect(max).toBe(20_000)
    expect(farthest!.r).toBeCloseTo(RIM / 2)
  })

  it('draws nothing without receptions', () => {
    const { max, farthest } = sectorLayout(stats([]), RIM)
    expect(max).toBe(0)
    expect(farthest).toBeNull()
  })
})
