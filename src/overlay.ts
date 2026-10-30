// Chart plotter overlay (SPEC 6.3, ARCHITECTURE 2.10): a read-only
// `plotterExtensions` resource provider serving one manifest while the
// plugin runs. The data overlay's MapLibre style is inline in the manifest;
// its GeoJSON source is a read-only plugin route fetched with the user's
// credentials, and a background page refreshes it hourly.
import { destination } from './geo'
import type { LatLon } from './ownposition'
import type { Radar } from './query'

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
        paint: {
          'fill-color': [
            'interpolate',
            ['linear'],
            ['get', 'intensity'],
            0,
            '#9ecae1',
            1,
            '#08519c',
          ],
          'fill-opacity': 0.35,
        },
      },
      {
        id: 'radar',
        type: 'line',
        source: OVERLAY_SOURCE,
        filter: ['==', ['get', 'kind'], 'radar'],
        paint: { 'line-color': '#d94801', 'line-width': 1.5 },
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
      'Where this vessel has received AIS positions over the last 7 days, and the 24 hour bearing radar.',
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
        opacity: 0.8,
        style: overlayStyle(urls.data),
      },
    ],
  }
}

/** One closed polygon per sector with data, from own position out to its p99. */
export function radarFeatures(radar: Radar, own: LatLon | undefined): object[] {
  if (!own) return []
  const out: object[] = []
  for (const s of radar.sectors) {
    if (s.p99Nm === null || s.p99Nm <= 0) continue
    const ring: number[][] = [[own.lon, own.lat]]
    for (let b = s.fromDeg; b <= s.toDeg; b += 2.5) {
      const p = destination(own, b, s.p99Nm)
      ring.push([round(p.lon), round(p.lat)])
    }
    ring.push([own.lon, own.lat])
    out.push({
      type: 'Feature',
      id: `radar-${s.sector}`,
      properties: {
        kind: 'radar',
        sector: s.sector,
        p99Nm: Math.round(s.p99Nm * 10) / 10,
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
