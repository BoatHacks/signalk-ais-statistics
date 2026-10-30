// Coverage map with a window selector, the basemap switch and layer
// toggles for the coverage cells and the radar. Cells and radar use the
// plotter overlay's colours.
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
import { layerVisible, saveLayerVisible, type Layer } from './layers'
import {
  CELL_FILL_OPACITY,
  CELL_LINE_WIDTH,
  OVERLAY_OPACITY,
  RADAR_COLOUR,
  RADAR_LINE_WIDTH,
  cellColour,
} from '../../src/style'
import { SECTOR_WIDTH_DEG } from '../../src/paths'
import type { Unit } from './units'

export interface MapView {
  element: HTMLElement
  show(
    window: '24h' | '7d' | '30d',
    units: { distance: Unit; area: Unit },
  ): Promise<void>
  /** Re-reads the theme colours, after a day or night change. */
  restyle(): void
}

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const SEAMARK = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'

const bearings = (sector: number) =>
  `${sector * SECTOR_WIDTH_DEG}° to ${(sector + 1) * SECTOR_WIDTH_DEG}°`

export function createMap(): MapView {
  const element = el('div', { class: 'map-view' })
  const info = el('p', { class: 'muted small' })
  const switcher = el('div', {
    class: 'map-switcher',
    role: 'group',
    'aria-label': 'Basemap',
  })
  const toggles = el('div', {
    class: 'map-switcher map-layers',
    role: 'group',
    'aria-label': 'Layers',
  })
  const mapEl = el('div', { class: 'map' })
  const card = el(
    'div',
    { class: 'map-card sk-card' },
    mapEl,
    switcher,
    toggles,
  )
  element.append(card, info)

  let map: L.Map | undefined
  let base: L.Layer[] = []
  let cells: L.GeoJSON | undefined
  let radar: L.GeoJSON | undefined
  const visible: Record<Layer, boolean> = {
    cells: layerVisible('cells'),
    radar: layerVisible('radar'),
  }
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
    radar?.bringToFront()
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

  function applyVisibility() {
    for (const [name, layer] of [
      ['cells', cells],
      ['radar', radar],
    ] as const) {
      if (!map || !layer) continue
      if (visible[name] && !map.hasLayer(layer)) layer.addTo(map)
      if (!visible[name] && map.hasLayer(layer)) layer.remove()
    }
    radar?.bringToFront()
    for (const btn of toggles.querySelectorAll('button'))
      btn.setAttribute(
        'aria-pressed',
        String(visible[btn.dataset.layer as Layer]),
      )
  }

  for (const [name, label] of [
    ['cells', 'Cells'],
    ['radar', 'Radar 24h'],
  ] as const) {
    const btn = el('button', { type: 'button', 'data-layer': name }, label)
    btn.addEventListener('click', () => {
      visible[name] = !visible[name]
      saveLayerVisible(name, visible[name])
      applyVisibility()
    })
    toggles.append(btn)
  }
  applyVisibility()

  async function ensureMap() {
    if (map) return
    map = L.map(mapEl, { worldCopyJump: true }).setView([0, 0], 2)
    const chosen =
      savedBasemap() ?? defaultBasemap(await internetState(), navigator.onLine)
    await setBasemap(chosen)
  }

  // The plotter draws the overlay at OVERLAY_OPACITY on top of the paint
  // opacity, so the same product here gives the same look.
  const cellStyle = (f?: GeoJSON.Feature): L.PathOptions => {
    const color = cellColour(Number(f?.properties?.intensity ?? 0))
    return {
      color,
      weight: CELL_LINE_WIDTH,
      opacity: OVERLAY_OPACITY,
      fillColor: color,
      fillOpacity: CELL_FILL_OPACITY * OVERLAY_OPACITY,
    }
  }

  const radarStyle: L.PathOptions = {
    color: RADAR_COLOUR,
    weight: RADAR_LINE_WIDTH,
    opacity: OVERLAY_OPACITY,
    fill: false,
  }

  return {
    element,
    restyle() {
      // Cell and radar colours follow the plotter overlay, not the theme.
    },
    async show(window, units) {
      await ensureMap()
      map!.invalidateSize()
      const [c, overlay] = await Promise.all([
        get<CoverageResponse>('/coverage', { window }),
        get<GeoJSON.FeatureCollection>('/overlay/coverage.geojson').catch(
          () => undefined,
        ),
      ])
      cells?.remove()
      radar?.remove()
      cells = L.geoJSON(c.geojson, {
        style: cellStyle,
        onEachFeature: (f, layer) =>
          layer.bindTooltip(
            `${f.properties?.reports} reports, nearest ${units.distance.format(f.properties?.minDistanceM)}`,
          ),
      })
      const wedges: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: (overlay?.features ?? []).filter(
          (f) => f.properties?.kind === 'radar',
        ),
      }
      radar = L.geoJSON(wedges, {
        style: radarStyle,
        onEachFeature: (f, layer) =>
          layer.bindTooltip(
            `${bearings(Number(f.properties?.sector))}: p99 ${units.distance.format(f.properties?.p99M)} over 24h`,
          ),
      })
      applyVisibility()
      if (!fitted && c.cells > 0) {
        map!.fitBounds(cells.getBounds(), { padding: [16, 16] })
        fitted = true
      }
      info.textContent =
        c.cells === 0
          ? 'No coverage recorded in this window yet.'
          : `${c.cells.toLocaleString()} cells, about ${units.area.format(c.areaM2)} covered.` +
            (c.capM === null
              ? ''
              : ` ${c.cappedCells} cells beyond ${units.distance.format(c.capM)} (the distance percentile cap) are not shown.`) +
            ` Basemap: ${current === 'osm' ? 'OpenStreetMap and OpenSeaMap' : 'server charts'}.`
    },
  }
}
