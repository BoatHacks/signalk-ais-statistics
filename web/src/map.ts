// Coverage map with a window selector and the basemap switch.
import * as L from 'leaflet'
import { get, type CoverageResponse } from './api'
import {
  defaultBasemap,
  internetState,
  saveBasemap,
  savedBasemap,
  serverCharts,
  type Basemap,
} from './basemap'
import { el } from './format'

export interface MapView {
  element: HTMLElement
  show(window: '24h' | '7d' | '30d'): Promise<void>
}

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const SEAMARK = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'

export function createMap(): MapView {
  const element = el('div', { class: 'map-view' })
  const info = el('p', { class: 'muted' })
  const switcher = el('div', { class: 'segmented', role: 'group' })
  const mapEl = el('div', { class: 'map' })
  element.append(switcher, mapEl, info)

  let map: L.Map | undefined
  let base: L.Layer[] = []
  let cells: L.GeoJSON | undefined
  let current: Basemap | undefined
  let fitted = false

  async function setBasemap(b: Basemap) {
    if (!map) return
    current = b
    for (const l of base) l.remove()
    base = []
    if (b === 'osm') {
      base.push(
        L.tileLayer(OSM, {
          maxZoom: 18,
          attribution: '&copy; OpenStreetMap contributors',
        }),
        L.tileLayer(SEAMARK, {
          maxZoom: 18,
          attribution: '&copy; OpenSeaMap',
        }),
      )
    } else {
      for (const c of await serverCharts())
        base.push(
          L.tileLayer(c.url, {
            minZoom: c.minzoom ?? 0,
            maxZoom: 20,
            maxNativeZoom: c.maxzoom ?? 18,
          }),
        )
    }
    for (const l of base) l.addTo(map)
    cells?.bringToFront()
    for (const btn of switcher.querySelectorAll('button'))
      btn.setAttribute('aria-pressed', String(btn.dataset.basemap === b))
  }

  for (const [b, label] of [
    ['osm', 'OpenStreetMap'],
    ['charts', 'Server charts'],
  ] as const) {
    const btn = el('button', { type: 'button', 'data-basemap': b }, label)
    btn.addEventListener('click', () => {
      saveBasemap(b)
      void setBasemap(b)
    })
    switcher.append(btn)
  }

  async function ensureMap() {
    if (map) return
    map = L.map(mapEl, { worldCopyJump: true }).setView([0, 0], 2)
    const chosen =
      savedBasemap() ?? defaultBasemap(await internetState(), navigator.onLine)
    await setBasemap(chosen)
  }

  return {
    element,
    async show(window) {
      await ensureMap()
      map!.invalidateSize()
      const c = await get<CoverageResponse>('/coverage', { window })
      cells?.remove()
      cells = L.geoJSON(c.geojson, {
        style: (f) => {
          const t = Number(f?.properties?.intensity ?? 0)
          return {
            color: '#185fa8',
            weight: 0.5,
            fillColor: '#2a78d6',
            fillOpacity: 0.15 + 0.5 * t,
          }
        },
        onEachFeature: (f, layer) =>
          layer.bindTooltip(
            `${f.properties.reports} reports, nearest ${f.properties.minDistanceNm} nm`,
          ),
      }).addTo(map!)
      if (!fitted && c.cells > 0) {
        map!.fitBounds(cells.getBounds(), { padding: [16, 16] })
        fitted = true
      }
      info.textContent =
        c.cells === 0
          ? 'No coverage recorded in this window yet.'
          : `${c.cells.toLocaleString()} cells, about ${c.areaKm2.toLocaleString()} km² covered.` +
            (c.capNm === null
              ? ''
              : ` ${c.cappedCells} cells beyond ${c.capNm.toFixed(0)} nm (the distance percentile cap) are not shown.`) +
            ` Basemap: ${current === 'osm' ? 'OpenStreetMap and OpenSeaMap' : 'server charts'}.`
    },
  }
}
