import { describe, expect, it } from 'vitest'
import {
  OVERLAY_ID,
  OVERLAY_SOURCE,
  buildManifest,
  radarFeatures,
} from '../src/overlay'
import type { Radar } from '../src/query'

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
})

describe('radarFeatures', () => {
  const radar: Radar = {
    window: '24h',
    class: 'all',
    source: 'live',
    sectors: Array.from({ length: 24 }, (_, s) => ({
      sector: s,
      fromDeg: s * 15,
      toDeg: s * 15 + 15,
      count: s === 2 ? 5 : 0,
      p99M: s === 2 ? 20 * 1852 : null,
    })),
  }

  it('draws a closed wedge per sector with data', () => {
    const f = radarFeatures(radar, { lat: 0, lon: 0 }) as {
      geometry: { coordinates: number[][][] }
    }[]
    expect(f).toHaveLength(1)
    const ring = f[0]!.geometry.coordinates[0]!
    expect(ring[0]).toEqual(ring[ring.length - 1])
    expect(ring.length).toBeGreaterThan(4)
  })

  it('draws nothing without an own position', () => {
    expect(radarFeatures(radar, undefined)).toEqual([])
  })
})
