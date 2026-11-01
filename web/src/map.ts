// Coverage map with a window selector, the basemap switch and layer
// toggles for the coverage cells and the class A and B sectors. Cells and
// sectors use the plotter overlay's colours.
import * as L from 'leaflet'
import { get, type CoverageResponse } from './api'
import {
  chooseBasemap,
  internetState,
  saveBasemap,
  savedBasemap,
  serverCharts,
  type Basemap,
  type ChartLayer,
} from './basemap'
import { el } from './format'
import { layerVisible, saveLayerVisible, type Layer } from './layers'
import {
  CELL_FILL_OPACITY,
  CELL_LINE_WIDTH,
  OVERLAY_OPACITY,
  SECTOR_LINE_WIDTH,
  SECTOR_MAX_LINE_WIDTH,
  cellColour,
  sectorColour,
} from '../../src/style'
import { maxTime } from './time'
import { SECTOR_WIDTH_DEG } from '../../src/paths'
import type { Unit } from './units'

export interface MapView {
  element: HTMLElement
  show(
    window: '24h' | '7d',
    units: { distance: Unit; area: Unit },
    offsetMin?: number,
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
    class: 'map-switcher',
    role: 'group',
    'aria-label': 'Layers',
  })
  const noCharts = el(
    'p',
    { class: 'map-note', role: 'status', hidden: '' },
    'No charts on this server.',
  )
  const controls = el(
    'div',
    { class: 'map-controls' },
    switcher,
    noCharts,
    toggles,
  )
  const mapEl = el('div', { class: 'map' })
  const card = el('div', { class: 'map-card sk-card' }, mapEl, controls)
  element.append(card, info)

  let map: L.Map | undefined
  let base: L.Layer[] = []
  let cells: L.GeoJSON | undefined
  let capped: L.GeoJSON | undefined
  let sectorsA: L.GeoJSON | undefined
  let sectorsB: L.GeoJSON | undefined
  const visible: Record<Layer, boolean> = {
    cells: layerVisible('cells'),
    capped: layerVisible('capped'),
    sectorsA: layerVisible('sectorsA'),
    sectorsB: layerVisible('sectorsB'),
  }
  // Class B on top, as in the plotter overlay: its wedges are usually the
  // shorter ones and would otherwise hide under class A's outlines.
  const sectorsToFront = () => {
    sectorsA?.bringToFront()
    sectorsB?.bringToFront()
  }
  let lastInfo: (() => void) | undefined
  let current: Basemap | undefined
  let charts: ChartLayer[] = []
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
      for (const c of charts)
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
    capped?.bringToFront()
    sectorsToFront()
    for (const btn of switcher.querySelectorAll('button'))
      btn.setAttribute('aria-pressed', String(btn.dataset.basemap === b))
  }

  for (const [b, label] of [
    ['osm', 'OpenStreetMap'],
    ['charts', 'Server charts'],
  ] as const) {
    const btn = el('button', { type: 'button', 'data-basemap': b }, label)
    // Server charts stay disabled until the chart list is known.
    if (b === 'charts') btn.disabled = true
    btn.addEventListener('click', () => {
      saveBasemap(b)
      void setBasemap(b)
    })
    switcher.append(btn)
  }

  function applyVisibility() {
    for (const [name, layer] of [
      ['cells', cells],
      ['capped', capped],
      ['sectorsA', sectorsA],
      ['sectorsB', sectorsB],
    ] as const) {
      if (!map || !layer) continue
      if (visible[name] && !map.hasLayer(layer)) layer.addTo(map)
      if (!visible[name] && map.hasLayer(layer)) layer.remove()
    }
    sectorsToFront()
    for (const btn of toggles.querySelectorAll('button'))
      btn.setAttribute(
        'aria-pressed',
        String(visible[btn.dataset.layer as Layer]),
      )
    lastInfo?.()
  }

  for (const [name, label] of [
    ['cells', 'Cells'],
    ['capped', 'All cells'],
    ['sectorsA', 'Sectors A'],
    ['sectorsB', 'Sectors B'],
  ] as const) {
    const btn = el('button', { type: 'button', 'data-layer': name }, label)
    if (name === 'capped')
      btn.title = 'Also show sparse cells beyond the distance percentile cap'
    if (name === 'sectorsA' || name === 'sectorsB') {
      btn.title = `Class ${name === 'sectorsA' ? 'A' : 'B'} sectors over 24 hours`
      // A swatch in the class colour, as on the sectors page.
      const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' })
      swatch.style.background = sectorColour(name === 'sectorsA' ? 'a' : 'b')
      btn.prepend(swatch)
    }
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
    const [state, found] = await Promise.all([internetState(), serverCharts()])
    charts = found
    // Without server charts that basemap would stay blank, so its button is
    // greyed out with a note saying why.
    const chartsBtn = switcher.querySelector<HTMLButtonElement>(
      'button[data-basemap="charts"]',
    )
    if (chartsBtn) chartsBtn.disabled = charts.length === 0
    noCharts.hidden = charts.length > 0
    await setBasemap(
      chooseBasemap(savedBasemap(), state, navigator.onLine, charts.length > 0),
    )
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

  // Cells beyond the cap: outline only, dashed, so they read as outliers.
  const cappedStyle = (f?: GeoJSON.Feature): L.PathOptions => ({
    ...cellStyle(f),
    fill: false,
    dashArray: '4 3',
  })

  const sectorStyle = (f?: GeoJSON.Feature): L.PathOptions => ({
    color: sectorColour(f?.properties?.cls),
    weight:
      f?.properties?.kind === 'sector-max'
        ? SECTOR_MAX_LINE_WIDTH
        : SECTOR_LINE_WIDTH,
    opacity: OVERLAY_OPACITY,
    fill: false,
  })

  return {
    element,
    restyle() {
      // Cell and sector colours follow the plotter overlay, not the theme.
    },
    async show(window, units, offsetMin) {
      await ensureMap()
      map!.invalidateSize()
      const [c, overlay] = await Promise.all([
        get<CoverageResponse>('/coverage', { window, all: 'true' }),
        get<GeoJSON.FeatureCollection>('/overlay/coverage.geojson').catch(
          () => undefined,
        ),
      ])
      cells?.remove()
      capped?.remove()
      sectorsA?.remove()
      sectorsB?.remove()
      const cellTip = (f: GeoJSON.Feature, layer: L.Layer) =>
        layer.bindTooltip(
          `${f.properties?.reports} reports, nearest ${units.distance.format(f.properties?.minDistanceM)}` +
            (f.properties?.capped ? ', beyond the distance cap' : ''),
        )
      const pick = (beyond: boolean): GeoJSON.FeatureCollection => ({
        type: 'FeatureCollection',
        features: c.geojson.features.filter(
          (f) => Boolean(f.properties?.capped) === beyond,
        ),
      })
      cells = L.geoJSON(pick(false), {
        style: cellStyle,
        onEachFeature: cellTip,
      })
      capped = L.geoJSON(pick(true), {
        style: cappedStyle,
        onEachFeature: cellTip,
      })
      const sectorTip = (f: GeoJSON.Feature, layer: L.Layer) => {
        const p = f.properties ?? {}
        const where = `Class ${String(p.cls).toUpperCase()}, ${bearings(Number(p.sector))}`
        if (p.kind === 'sector-max')
          layer.bindTooltip(
            `${where}: farthest ${units.distance.format(p.maxM)} in 24h, ${maxTime(
              {
                maxAt: typeof p.maxAt === 'string' ? p.maxAt : null,
                maxHour: typeof p.maxHour === 'string' ? p.maxHour : null,
              },
              offsetMin,
            )}`,
          )
        else
          layer.bindTooltip(
            `${where}: p99 ${units.distance.format(p.p99M)} over 24h`,
          )
      }
      const sectorLayer = (cls: 'a' | 'b') =>
        L.geoJSON(
          {
            type: 'FeatureCollection',
            features: (overlay?.features ?? []).filter(
              (f) =>
                f.properties?.cls === cls &&
                (f.properties?.kind === 'sector' ||
                  f.properties?.kind === 'sector-max'),
            ),
          } as GeoJSON.FeatureCollection,
          { style: sectorStyle, onEachFeature: sectorTip },
        )
      sectorsA = sectorLayer('a')
      sectorsB = sectorLayer('b')
      applyVisibility()
      // The first view frames the cells and the sector wedges of both
      // classes together; the wedges reach past the cells where the p99
      // range exceeds them. The farthest-reception ticks can reach far
      // beyond, so they do not count.
      const framed = L.geoJSON({
        type: 'FeatureCollection',
        features: (overlay?.features ?? []).filter(
          (f) => f.properties?.kind === 'sector',
        ),
      } as GeoJSON.FeatureCollection)
      if (!fitted && (c.cells > 0 || framed.getLayers().length > 0)) {
        const bounds = L.latLngBounds([])
        for (const layer of [cells, framed])
          if (layer.getLayers().length > 0) bounds.extend(layer.getBounds())
        map!.fitBounds(bounds, { padding: [16, 16] })
        fitted = true
      }
      lastInfo = () => {
        const beyond =
          c.capM === null || c.cappedCells === 0
            ? ''
            : visible.capped
              ? ` Including ${c.cappedCells} sparse cells beyond ${units.distance.format(c.capM)} (the distance percentile cap), dashed.`
              : ` ${c.cappedCells} cells beyond ${units.distance.format(c.capM)} (the distance percentile cap) with fewer than 3 reports are not shown; All cells shows them.`
        info.textContent =
          c.cells + c.cappedCells === 0
            ? 'No coverage recorded in this window yet.'
            : `${c.cells.toLocaleString()} cells, about ${units.area.format(c.areaM2)} covered.` +
              beyond +
              ` Basemap: ${current === 'osm' ? 'OpenStreetMap and OpenSeaMap' : 'server charts'}.`
      }
      lastInfo()
    },
  }
}
