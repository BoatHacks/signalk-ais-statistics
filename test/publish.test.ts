import { describe, expect, it } from 'vitest'
import { Aggregator } from '../src/aggregate'
import { destination } from '../src/geo'
import { PATH_PREFIX, paths } from '../src/paths'
import { buildValues, defaultMetadata, publish } from '../src/publish'
import { OWN } from './fixtures/ais'

const T0 = Date.UTC(2030, 0, 1)

describe('buildValues', () => {
  it('publishes every counter even before any data, and no empty gauges', () => {
    const values = buildValues(new Aggregator(T0), T0)
    const byPath = new Map(values.map((v) => [v.path, v.value]))
    expect(byPath.get(paths.messagesTotal)).toBe(0)
    expect(byPath.get(paths.distanceBin(31))).toBe(0)
    expect(byPath.get(paths.sectorCount(23, 'b'))).toBe(0)
    expect(byPath.get(paths.vesselsLast24h)).toBe(0)
    expect(byPath.has(paths.distanceP99)).toBe(false)
    expect(byPath.has(paths.coverageCellsToday)).toBe(false)
    expect(byPath.get(paths.healthDuplicatesCrossEvent)).toBe(0)
    // 4 counters + 32 bins + 7 health + 48 sectors + 2 + 14 vessel gauges
    expect(values).toHaveLength(4 + 32 + 7 + 48 + 2 + 14)
  })

  it('leaves the sector paths out when asked', () => {
    const values = buildValues(new Aggregator(T0), T0, undefined, {
      sectors: false,
    })
    expect(values.some((v) => v.path.includes('.sectors.'))).toBe(false)
    expect(values).toHaveLength(4 + 32 + 7 + 2 + 14)
  })

  it('publishes the farthest reception per sector with the sector paths', () => {
    const agg = new Aggregator(T0)
    agg.add(
      { type: 1, mmsi: '999000001', ...destination(OWN, 50, 300) },
      OWN,
      T0,
    )
    const byPath = new Map(
      buildValues(agg, T0 + 1000).map((v) => [v.path, v.value]),
    )
    expect(byPath.get(paths.sectorMax(3, 'a'))).toBeCloseTo(300 * 1852, -2)
    expect(byPath.has(paths.sectorMax(3, 'b'))).toBe(false)
  })

  it('publishes only finite numbers under the prefix', () => {
    const agg = new Aggregator(T0)
    const p = destination(OWN, 37, 25)
    agg.add({ type: 1, mmsi: '999000001', ...p }, OWN, T0)
    const values = buildValues(agg, T0 + 1000, { cells: 3, areaKm2: 750 })
    for (const v of values) {
      expect(v.path.startsWith(PATH_PREFIX)).toBe(true)
      expect(typeof v.value).toBe('number')
      expect(Number.isFinite(v.value)).toBe(true)
    }
    const byPath = new Map(values.map((v) => [v.path, v.value]))
    // Gauges are published in SI units (SPEC 6.2).
    expect(byPath.get(paths.distanceMax)).toBeCloseTo(25 * 1852, 0)
    expect(byPath.get(paths.distanceP99)).toBeGreaterThan(20 * 1852)
    expect(byPath.get(paths.sectorP99(2, 'a'))).toBeGreaterThan(14 * 1852)
    expect(byPath.get(paths.coverageCellsToday)).toBe(3)
    expect(byPath.get(paths.coverageAreaToday)).toBe(750e6)
    expect(new Set(values.map((v) => v.path)).size).toBe(values.length)
  })
})

describe('publish', () => {
  it('sends one delta with a timestamp and the plugin id', () => {
    const sent: [string, object][] = []
    const sink = {
      handleMessage: (id: string, d: object) => sent.push([id, d]),
    }
    publish(sink, 'plugin', [{ path: paths.messagesTotal, value: 1 }], T0)
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toBe('plugin')
    expect(sent[0]![1]).toMatchObject({
      updates: [{ timestamp: new Date(T0).toISOString() }],
    })
    publish(sink, 'plugin', [], T0)
    expect(sent).toHaveLength(1)
  })

  it('suggests SI metadata for every distance and area gauge', () => {
    const meta = defaultMetadata()
    const byPath = new Map(meta.map((m) => [m.path, m.meta]))
    expect(byPath.get(paths.distanceP99)?.units).toBe('m')
    expect(byPath.get(paths.sectorP99(23, 'b'))?.units).toBe('m')
    expect(byPath.get(paths.sectorMax(23, 'b'))?.units).toBe('m')
    expect(byPath.get(paths.coverageAreaToday)?.units).toBe('m2')
    expect(byPath.has(paths.messagesTotal)).toBe(false)
    expect(byPath.get(paths.propagationRatio)?.units).toBe('ratio')
    expect(meta).toHaveLength(5 + 48 + 48 + 1 + 1)
  })
})
