import { describe, expect, it } from 'vitest'
import {
  OVERLAY_ID,
  OVERLAY_SOURCE,
  buildManifest,
  sectorFeatures,
} from '../src/overlay'
import type { SectorStats } from '../src/query'

describe('overlay manifest', () => {
  it('declares a version 1 data overlay with an inline version 8 style', () => {
    const m = buildManifest('plugin-id', '1.2.3') as {
      apiVersion: string
      requires: string[]
      background: { url: string }[]
      overlays: {
        id: string
        type: string
        band: string
        style: {
          version: number
          sources: Record<string, { data: string }>
          layers: { source: string }[]
        }
      }[]
    }
    expect(m.apiVersion).toBe('1')
    expect(m.requires).toEqual(['overlays.data'])
    const o = m.overlays[0]!
    expect(o).toMatchObject({
      id: OVERLAY_ID,
      type: 'data',
      band: 'aboveCharts',
    })
    expect(o.style.version).toBe(8)
    expect(o.style.sources[OVERLAY_SOURCE]!.data).toBe(
      '/plugins/plugin-id/overlay/coverage.geojson',
    )
    for (const l of o.style.layers) expect(l.source).toBe(OVERLAY_SOURCE)
    expect(m.background[0]!.url).toBe('/plugin-id/plotterext/refresh.html')
  })

  it('fills and outlines cells, and outlines the sectors', () => {
    const m = buildManifest('plugin-id', '1.2.3') as {
      overlays: {
        style: { layers: { id: string; type: string; filter: unknown[] }[] }
      }[]
    }
    const layers = m.overlays[0]!.style.layers.map((l) => [
      l.id,
      l.type,
      l.filter[2],
    ])
    expect(layers).toEqual([
      ['cells', 'fill', 'cell'],
      ['cell-outlines', 'line', 'cell'],
      ['sectors', 'line', 'sector'],
      ['sector-max', 'line', 'sector-max'],
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

  it('draws a tick from the wedge out to the farthest reception', () => {
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
    const ticks = (
      sectorFeatures(withMax, { lat: 0, lon: 0 }) as {
        properties: Record<string, unknown>
        geometry: { type: string; coordinates: number[][] }
      }[]
    ).filter((f) => f.properties.kind === 'sector-max')
    expect(ticks.map((t) => t.properties.sector)).toEqual([2, 5])
    expect(ticks[0]!.geometry.type).toBe('LineString')
    expect(ticks[0]!.properties).toMatchObject({
      maxM: 300 * 1852,
      maxAt: '2030-01-01T12:00:00.000Z',
    })
    // Sector 5 has no wedge, so its tick starts at own position.
    expect(ticks[1]!.geometry.coordinates[0]).toEqual([0, 0])
    expect(ticks[1]!.properties.maxHour).toBe('2030-01-01T11:00:00.000Z')
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
