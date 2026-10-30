// Basemap choice (SPEC 7): OpenStreetMap with OpenSeaMap when online and
// not metered, otherwise the server's chart provider. A manual choice wins
// and is remembered per browser.
export type Basemap = 'osm' | 'charts'

const KEY = 'signalk-ais-statistics.basemap'

export function savedBasemap(): Basemap | undefined {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'osm' || v === 'charts' ? v : undefined
  } catch {
    return undefined
  }
}

export function saveBasemap(b: Basemap): void {
  try {
    localStorage.setItem(KEY, b)
  } catch {
    // storage unavailable, the choice lasts for this page only
  }
}

/** `network.internet.state` from the internet-status plugin, if installed. */
export async function internetState(): Promise<string | undefined> {
  try {
    const res = await fetch(
      '/signalk/v1/api/vessels/self/network/internet/state/value',
      { credentials: 'same-origin' },
    )
    if (!res.ok) return undefined
    const v: unknown = await res.json()
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

export function defaultBasemap(
  state: string | undefined,
  browserOnline: boolean,
): Basemap {
  if (state === 'online') return 'osm'
  if (state === 'offline' || state === 'metered') return 'charts'
  return browserOnline ? 'osm' : 'charts'
}

export interface ChartLayer {
  name: string
  url: string
  minzoom?: number
  maxzoom?: number
}

/** Tile layers of the server's chart provider (resources API, `charts`). */
export async function serverCharts(): Promise<ChartLayer[]> {
  try {
    const res = await fetch('/signalk/v2/api/resources/charts', {
      credentials: 'same-origin',
    })
    if (!res.ok) return []
    const all = (await res.json()) as Record<string, Record<string, unknown>>
    const out: ChartLayer[] = []
    for (const [id, c] of Object.entries(all)) {
      const url = typeof c.url === 'string' ? c.url : c.tilemapUrl
      if (typeof url !== 'string' || !url.includes('{z}')) continue
      out.push({
        name: typeof c.name === 'string' ? c.name : id,
        url,
        minzoom: typeof c.minzoom === 'number' ? c.minzoom : undefined,
        maxzoom: typeof c.maxzoom === 'number' ? c.maxzoom : undefined,
      })
    }
    return out
  } catch {
    return []
  }
}
