import { describe, expect, it } from 'vitest'
import {
  DISTANCE_BIN_COUNT,
  PATH_PREFIX,
  SECTOR_CLASSES,
  SECTOR_COUNT,
  TYPE_GROUPS,
  distanceBinPaths,
  paths,
} from '../src/paths'

describe('paths', () => {
  it('formats bin and sector labels as in SPEC 6.2', () => {
    expect(paths.distanceBin(0)).toBe(`${PATH_PREFIX}.distance.bin.00`)
    expect(paths.distanceBin(31)).toBe(`${PATH_PREFIX}.distance.bin.31`)
    expect(paths.sectorCount(0, 'a')).toBe(`${PATH_PREFIX}.sectors.000.a.count`)
    expect(paths.sectorP99(23, 'b')).toBe(`${PATH_PREFIX}.sectors.345.b.p99`)
    expect(paths.distanceP99).toBe(`${PATH_PREFIX}.distance.p99`)
    expect(paths.coverageAreaToday).toBe(`${PATH_PREFIX}.coverage.area.today`)
  })

  it('has one path per bin and per sector and class', () => {
    expect(distanceBinPaths).toHaveLength(DISTANCE_BIN_COUNT)
    const sectorPaths = new Set<string>()
    for (let s = 0; s < SECTOR_COUNT; s++)
      for (const c of SECTOR_CLASSES) sectorPaths.add(paths.sectorCount(s, c))
    expect(sectorPaths.size).toBe(48)
  })

  it('keeps every path under the prefix and free of spaces', () => {
    const all = [
      paths.messagesTotal,
      ...distanceBinPaths,
      ...TYPE_GROUPS.map(paths.vesselsByGroupLast24h),
      paths.coverageAreaToday,
    ]
    for (const p of all) {
      expect(p.startsWith(`${PATH_PREFIX}.`)).toBe(true)
      expect(p).not.toMatch(/\s/)
    }
  })
})
