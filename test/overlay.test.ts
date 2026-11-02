import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OVERLAY_CELLS,
  OVERLAY_SECTORS,
  buildManifest,
  sectorFeatures,
} from '../src/overlay'
import type { SectorStats } from '../src/query'

interface Manifest {
  apiVersion: string
  requires: string[]
  background: { url: string }[]
  overlays: {
    id: string
    title: string
    type: string
    band: string
    visible: boolean
    style: {
      version: number
      sources: Record<string, { type: string; data: string }>
      layers: { id: string; type: string; source: string; filter: unknown[] }[]
    }
  }[]
}

describe('overlay manifest', () => {
  const m = buildManifest('plugin-id', '1.2.3') as Manifest

  it('declares two version 1 data overlays, cells and sectors', () => {
    expect(m.apiVersion).toBe('1')
    expect(m.requires).toEqual(['overlays.data'])
    expect(m.overlays.map((o) => [o.id, o.title])).toEqual([
      [OVERLAY_CELLS, 'AIS coverage cells'],
      [OVERLAY_SECTORS, 'AIS sectors'],
    ])
    for (const o of m.overlays)
      expect(o).toMatchObject({
        type: 'data',
        band: 'aboveCharts',
        visible: true,
      })
    expect(m.background[0]!.url).toBe('/plugin-id/plotterext/refresh.html')
  })

  it('gives each overlay its own inline style and GeoJSON route', () => {
    const [cells, sectors] = m.overlays
    for (const [o, route] of [
      [cells!, '/plugins/plugin-id/overlay/cells.geojson'],
      [sectors!, '/plugins/plugin-id/overlay/sectors.geojson'],
    ] as const) {
      expect(o.style.version).toBe(8)
      // The refresh page reloads each overlay by a source of the same id.
      expect(o.style.sources).toEqual({
        [o.id]: { type: 'geojson', data: route },
      })
      for (const l of o.style.layers) expect(l.source).toBe(o.id)
    }
  })

  it('has the refresh page reload every overlay', () => {
    const page = readFileSync(
      join(__dirname, '../web/static/plotterext/refresh.html'),
      'utf8',
    )
    const ids = /var OVERLAYS = \[([^\]]*)\]/.exec(page)?.[1]
    expect(ids?.split(',').map((x) => x.trim().replace(/'/g, ''))).toEqual(
      m.overlays.map((o) => o.id),
    )
  })

  it('fills and outlines cells in one overlay, sectors in the other', () => {
    const layers = m.overlays.map((o) =>
      o.style.layers.map((l) => [l.id, l.type, l.filter[2]]),
    )
    expect(layers).toEqual([
      [
        ['cells', 'fill', 'cell'],
        ['cell-outlines', 'line', 'cell'],
      ],
      [
        ['sectors', 'line', 'sector'],
        ['sector-max', 'circle', 'sector-max'],
      ],
    ])
  })
})

describe('sectorFeatures', () => {
  const stats: SectorStats = {
    window: '24h',
    from: '2030-01-01T00:00:00.000Z',
    to: '2030-01-02T00:00:00.000Z',
    class: 'a',
    source: 'live',
    sectors: Array.from({ length: 24 }, (_, s) => ({
      sector: s,
      fromDeg: s * 15,
      toDeg: s * 15 + 15,
      count: s === 2 ? 5 : 0,
      p99M: s === 2 ? 20 * 1852 : null,
      maxM: null,
      maxAt: null,
      maxHour: null,
    })),
  }

  it('puts one dot at the farthest reception and outlines its sector', () => {
    const withMax: SectorStats = {
      ...stats,
      sectors: stats.sectors.map((s) =>
        s.sector === 2
          ? { ...s, maxM: 300 * 1852, maxAt: '2030-01-01T12:00:00.000Z' }
          : s.sector === 5
            ? { ...s, maxM: 4 * 1852, maxHour: '2030-01-01T11:00:00.000Z' }
            : s,
      ),
    }
    const f = sectorFeatures(withMax, { lat: 0, lon: 0 }) as {
      properties: Record<string, unknown>
      geometry: { type: string; coordinates: number[] }
    }[]
    const dots = f.filter((x) => x.properties.kind === 'sector-max')
    expect(dots).toHaveLength(1)
    expect(dots[0]!.geometry.type).toBe('Point')
    expect(dots[0]!.properties).toMatchObject({
      sector: 2,
      maxM: 300 * 1852,
      maxAt: '2030-01-01T12:00:00.000Z',
    })
    // 300 nmi along 22.5 degrees from 0, 0 lies north-east.
    expect(dots[0]!.geometry.coordinates[0]).toBeGreaterThan(0)
    expect(dots[0]!.geometry.coordinates[1]).toBeGreaterThan(0)
    const wedge = f.find((x) => x.properties.kind === 'sector')!
    expect(wedge.properties.farthest).toBe(true)
  })

  it('draws no dot and no bold outline without a farthest reception', () => {
    const f = sectorFeatures(stats, { lat: 0, lon: 0 }) as {
      properties: Record<string, unknown>
    }[]
    expect(f.some((x) => x.properties.kind === 'sector-max')).toBe(false)
    expect(f.some((x) => x.properties.farthest)).toBe(false)
  })

  it('tags each feature with its class and keeps the ids apart', () => {
    const own = { lat: 0, lon: 0 }
    const a = sectorFeatures(stats, own) as {
      id: string
      properties: { cls: string }
    }[]
    const b = sectorFeatures({ ...stats, class: 'b' }, own) as typeof a
    expect(a[0]!.properties.cls).toBe('a')
    expect(b[0]!.properties.cls).toBe('b')
    expect(a[0]!.id).not.toBe(b[0]!.id)
  })

  it('draws a closed wedge per sector with data', () => {
    const f = sectorFeatures(stats, { lat: 0, lon: 0 }) as {
      geometry: { coordinates: number[][][] }
    }[]
    expect(f).toHaveLength(1)
    const ring = f[0]!.geometry.coordinates[0]!
    expect(ring[0]).toEqual(ring[ring.length - 1])
    expect(ring.length).toBeGreaterThan(4)
  })

  it('draws nothing without an own position', () => {
    expect(sectorFeatures(stats, undefined)).toEqual([])
  })
})
