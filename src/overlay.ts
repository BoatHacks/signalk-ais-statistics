// Chart plotter overlay (SPEC 6.3, ARCHITECTURE 2.10): a read-only
// `plotterExtensions` resource provider serving one manifest while the
// plugin runs. The data overlay's MapLibre style is inline in the manifest;
// its GeoJSON source is a read-only plugin route fetched with the user's
// credentials, and a background page refreshes it hourly.
import { destination, M_PER_NM } from './geo'
import type { LatLon } from './ownposition'
import type { SectorStats } from './query'
import {
  CELL_FILL_OPACITY,
  CELL_HIGH,
  CELL_LINE_WIDTH,
  CELL_LOW,
  OVERLAY_OPACITY,
  SECTOR_COLOURS,
  SECTOR_LINE_WIDTH,
  SECTOR_MAX_LINE_WIDTH,
} from './style'

export const OVERLAY_ID = 'coverage'
export const OVERLAY_SOURCE = 'coverage'
/** Footprint window shown on the plotter, in days. */
export const OVERLAY_DAYS = 7

export interface OverlayUrls {
  /** Server-relative URL of the GeoJSON route. */
  data: string
  /** Server-relative URL of the background refresh page. */
  background: string
}

export function overlayUrls(pluginId: string): OverlayUrls {
  return {
    data: `/plugins/${pluginId}/overlay/coverage.geojson`,
    background: `/${pluginId}/plotterext/refresh.html`,
  }
}

/** Teal for class A, orange for class B, as on the web app's sectors page. */
const SECTOR_COLOUR = [
  'match',
  ['get', 'cls'],
  'a',
  SECTOR_COLOURS.a,
  SECTOR_COLOURS.b,
]

const CELL_RAMP = [
  'interpolate',
  ['linear'],
  ['get', 'intensity'],
  0,
  CELL_LOW,
  1,
  CELL_HIGH,
]

export function overlayStyle(dataUrl: string): object {
  return {
    version: 8,
    sources: {
      [OVERLAY_SOURCE]: { type: 'geojson', data: dataUrl },
    },
    layers: [
      {
        id: 'cells',
        type: 'fill',
        source: OVERLAY_SOURCE,
        filter: ['==', ['get', 'kind'], 'cell'],
        paint: { 'fill-color': CELL_RAMP, 'fill-opacity': CELL_FILL_OPACITY },
      },
      {
        id: 'cell-outlines',
        type: 'line',
        source: OVERLAY_SOURCE,
        filter: ['==', ['get', 'kind'], 'cell'],
        paint: { 'line-color': CELL_RAMP, 'line-width': CELL_LINE_WIDTH },
      },
      {
        id: 'sectors',
        type: 'line',
        source: OVERLAY_SOURCE,
        filter: ['==', ['get', 'kind'], 'sector'],
        paint: {
          'line-color': SECTOR_COLOUR,
          'line-width': SECTOR_LINE_WIDTH,
        },
      },
      {
        id: 'sector-max',
        type: 'line',
        source: OVERLAY_SOURCE,
        filter: ['==', ['get', 'kind'], 'sector-max'],
        paint: {
          'line-color': SECTOR_COLOUR,
          'line-width': SECTOR_MAX_LINE_WIDTH,
        },
      },
    ],
  }
}

export function buildManifest(
  pluginId: string,
  version: string,
  urls: OverlayUrls = overlayUrls(pluginId),
): object {
  return {
    name: 'AIS reception coverage',
    description:
      'Where this vessel has received AIS positions over the last 7 days, and the 24 hour bearing sectors for class A and B.',
    version,
    apiVersion: '1',
    requires: ['overlays.data'],
    optional: ['background.iframe'],
    background: [
      {
        id: 'refresh',
        title: 'Coverage refresh',
        type: 'iframe',
        url: urls.background,
      },
    ],
    overlays: [
      {
        id: OVERLAY_ID,
        title: 'AIS coverage',
        type: 'data',
        band: 'aboveCharts',
        visible: true,
        opacity: OVERLAY_OPACITY,
        style: overlayStyle(urls.data),
      },
    ],
  }
}

/**
 * One closed polygon per sector with a p99, from own position out to it,
 * and one line per sector with a farthest reception beyond the wedge, along
 * the sector's centre bearing from the wedge's edge out to that distance.
 * Each feature carries the class (`cls`) of the sectors it was built from,
 * so class A and B can be drawn in their own colours.
 */
export function sectorFeatures(
  stats: SectorStats,
  own: LatLon | undefined,
): object[] {
  if (!own) return []
  const cls = stats.class
  const out: object[] = []
  for (const s of stats.sectors) {
    const inner = s.p99M ?? 0
    if (s.maxM !== null && s.maxM > inner) {
      const mid = (s.fromDeg + s.toDeg) / 2
      const a = destination(own, mid, inner / M_PER_NM)
      const b = destination(own, mid, s.maxM / M_PER_NM)
      out.push({
        type: 'Feature',
        id: `sector-max-${cls}-${s.sector}`,
        properties: {
          kind: 'sector-max',
          cls,
          sector: s.sector,
          maxM: s.maxM,
          maxAt: s.maxAt,
          maxHour: s.maxHour,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [round(a.lon), round(a.lat)],
            [round(b.lon), round(b.lat)],
          ],
        },
      })
    }
    if (s.p99M === null || s.p99M <= 0) continue
    const ring: number[][] = [[own.lon, own.lat]]
    for (let b = s.fromDeg; b <= s.toDeg; b += 2.5) {
      const p = destination(own, b, s.p99M / M_PER_NM)
      ring.push([round(p.lon), round(p.lat)])
    }
    ring.push([own.lon, own.lat])
    out.push({
      type: 'Feature',
      id: `sector-${cls}-${s.sector}`,
      properties: {
        kind: 'sector',
        cls,
        sector: s.sector,
        p99M: s.p99M,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    })
  }
  return out
}

const round = (x: number) => Math.round(x * 1e5) / 1e5

export interface ProviderRegistry {
  registerResourceProvider(provider: {
    type: string
    methods: Record<string, (...args: never[]) => Promise<unknown>>
  }): void
}

/**
 * Registers the read-only provider. The server cannot unregister a
 * provider, so `isRunning` decides whether the manifest is served.
 */
export function registerOverlayProvider(
  app: ProviderRegistry,
  pluginId: string,
  manifest: () => object,
  isRunning: () => boolean,
): void {
  app.registerResourceProvider({
    type: 'plotterExtensions',
    methods: {
      listResources: async () =>
        isRunning() ? { [pluginId]: manifest() } : {},
      getResource: async (id: string) => {
        if (!isRunning() || id !== pluginId)
          throw new Error(`No such plotterExtensions resource: ${id}`)
        return manifest()
      },
      setResource: async () => {
        throw new Error(`${pluginId} is a read-only provider`)
      },
      deleteResource: async () => {
        throw new Error(`${pluginId} is a read-only provider`)
      },
    },
  })
}
