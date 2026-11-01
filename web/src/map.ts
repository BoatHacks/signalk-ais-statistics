// Coverage map with a window selector, a selector for the cells of one own
// vessel mode (stationary or underway), the basemap switch and layer
// toggles for the coverage cells and the class A and B sectors. Cells and
// sectors use the plotter overlay's colours. A slider tries another coverage
// distance cap at once; users with write access can save it (SPEC 9.1).
import * as L from 'leaflet'
import { exportHref, get, type CoverageResponse } from './api'
import { showLoading } from './loading'
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
import { downloadLink, setLink } from './downloads'
import {
  SETTINGS_SAVED,
  canSave,
  capLabel,
  loginStatus,
  saveError,
  saveSettings,
} from './settings'
import { layerVisible, saveLayerVisible, type Layer } from './layers'
import {
  CELL_FILL_OPACITY,
  CELL_LINE_WIDTH,
  OVERLAY_OPACITY,
  SECTOR_FARTHEST_LINE_WIDTH,
  SECTOR_LINE_WIDTH,
  SECTOR_MAX_RADIUS,
  cellColour,
  sectorColour,
} from '../../src/style'
import { maxTime } from './time'
import { formatRoute, MAP_MODES, type MapMode } from './route'
import { SECTOR_WIDTH_DEG } from '../../src/paths'
import type { Unit } from './units'

export interface MapView {
  element: HTMLElement
  show(
    window: '24h' | '7d',
    units: { distance: Unit; area: Unit },
    offsetMin?: number,
    mode?: MapMode,
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

  // Cells by own vessel mode, below the map next to the cap slider.
  const modes = el(
    'div',
    { class: 'cap-control', role: 'group', 'aria-label': 'Cells from' },
    el('span', { class: 'label' }, 'Cells from'),
  )
  // Distance cap: the slider changes this view only, save stores it.
  const capInput = el('input', {
    type: 'range',
    id: 'cap-percentile',
    min: '50',
    max: '100',
    step: '1',
    value: '99',
  })
  const capValue = el('output', { for: 'cap-percentile' })
  const saveBtn = el('button', { type: 'button', hidden: '' }, 'Save')
  const resetBtn = el('button', { type: 'button', hidden: '' }, 'Reset')
  const capNote = el('p', { class: 'muted small', role: 'status' })
  const capRow = el(
    'div',
    { class: 'cap-control' },
    el('label', { for: 'cap-percentile' }, 'Distance cap'),
    capInput,
    capValue,
    saveBtn,
    resetBtn,
  )
  // Coverage downloads: the shown window and every retained day, with the
  // cells beyond the cap when All cells is on.
  const covWindow = downloadLink('CSV')
  const covAll = downloadLink('CSV, all days')
  const downloads = el(
    'div',
    { class: 'downloads', role: 'group', 'aria-label': 'Download coverage' },
    el('span', { class: 'downloads-label' }, 'Download cells'),
    covWindow,
    covAll,
  )
  const downloadNote = el(
    'p',
    { class: 'muted small' },
    'H3 cell ids with reports and the nearest distance. A footprint centred on a harbour can hint at your berth; you decide whether to share the file.',
  )
  let shownWindow: '24h' | '7d' = '24h'
  let shownMode: MapMode = 'all'
  const renderDownloads = () => {
    const flags = { all: visible.capped, mode: shownMode }
    setLink(covWindow, exportHref('coverage.csv', shownWindow, flags))
    setLink(covAll, exportHref('coverage.csv', 'all', flags))
  }

  // The mode is part of the route, so a link keeps it; it is never saved.
  const MODE_LABELS: Record<MapMode, string> = {
    all: 'All',
    stationary: 'Stationary',
    underway: 'Underway',
  }
  for (const m of MAP_MODES) {
    const btn = el('button', { type: 'button', 'data-mode': m }, MODE_LABELS[m])
    btn.title =
      m === 'all'
        ? 'Cells from all reports'
        : `Only cells from reports received while ${m}`
    btn.addEventListener('click', () => {
      location.hash = formatRoute({ view: 'map', window: shownWindow, mode: m })
    })
    modes.append(btn)
  }
  const renderModes = () => {
    for (const btn of modes.querySelectorAll('button'))
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === shownMode))
  }
  renderModes()
  element.append(card, modes, capRow, capNote, info, downloads, downloadNote)

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
  let lastArgs: Parameters<MapView['show']> | undefined
  let generation = 0
  /** The saved cap percentile, as the last answer without a trial gave it. */
  let savedCap: number | undefined
  /** A cap being tried, not saved. */
  let trialCap: number | undefined
  let mayWrite = false
  let saveMessage = ''
  let current: Basemap | undefined
  let charts: ChartLayer[] = []
  let fitted = false

  /**
   * Resolves once the basemap's visible tiles have loaded or failed, or
   * after 20 s, whichever comes first.
   */
  function tilesLoaded(): Promise<void> {
    const layers = base.filter(
      (l): l is L.TileLayer => l instanceof L.TileLayer,
    )
    const loaded = Promise.all(
      layers.map((l) => new Promise<void>((r) => l.once('load', () => r()))),
    ).then(() => undefined)
    return Promise.race([
      loaded,
      new Promise<void>((r) => setTimeout(r, 20_000)),
    ])
  }

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
      showLoading(btn, tilesLoaded())
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
    renderDownloads()
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

  function renderCap() {
    const shown = trialCap ?? savedCap
    if (shown !== undefined) {
      capInput.value = String(shown)
      capValue.textContent = capLabel(shown)
    }
    const pending = trialCap !== undefined && trialCap !== savedCap
    saveBtn.hidden = !(pending && mayWrite)
    resetBtn.hidden = !pending
    capNote.textContent = saveMessage
      ? saveMessage
      : !pending || savedCap === undefined
        ? 'Coverage leaves out sparse cells beyond this percentile of the distances, so bogus positions do not inflate it.'
        : mayWrite
          ? `Trying the ${capLabel(trialCap!)}, not saved; the plotter overlay keeps the ${capLabel(savedCap)} until you save.`
          : `Trying the ${capLabel(trialCap!)} in this view only. Saving needs a readwrite or admin login.`
  }

  let capTimer: ReturnType<typeof setTimeout> | undefined
  capInput.addEventListener('input', () => {
    trialCap = Number(capInput.value)
    saveMessage = ''
    renderCap()
    // Redraw once the slider rests, not on every step.
    clearTimeout(capTimer)
    capTimer = setTimeout(() => {
      if (lastArgs) void view.show(...lastArgs).catch(() => undefined)
    }, 300)
  })
  resetBtn.addEventListener('click', () => {
    trialCap = undefined
    saveMessage = ''
    renderCap()
    if (lastArgs)
      showLoading(
        resetBtn,
        view.show(...lastArgs).catch(() => undefined),
      )
  })
  saveBtn.addEventListener('click', () => {
    if (trialCap === undefined) return
    saveBtn.disabled = true
    const saving = saveSettings({ coverageDistancePercentile: trialCap })
    showLoading(saveBtn, saving)
    saving
      .then((s) => {
        savedCap = s.coverageDistancePercentile
        trialCap = undefined
        saveMessage = `Saved: the coverage cap is the ${capLabel(savedCap)}.`
        window.dispatchEvent(new Event(SETTINGS_SAVED))
        if (lastArgs) void view.show(...lastArgs).catch(() => undefined)
      })
      .catch((err: unknown) => {
        saveMessage = saveError(err)
        if (/login/.test(saveMessage)) mayWrite = false
      })
      .finally(() => {
        saveBtn.disabled = false
        renderCap()
      })
  })
  renderCap()
  void loginStatus().then((s) => {
    mayWrite = canSave(s)
    renderCap()
  })

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

  // Leaflet applies the style to the farthest dot too, so it covers both.
  const sectorStyle = (f?: GeoJSON.Feature): L.PathOptions =>
    f?.properties?.kind === 'sector-max'
      ? {
          color: sectorColour(f.properties.cls),
          weight: 0,
          fill: true,
          fillOpacity: OVERLAY_OPACITY,
        }
      : {
          color: sectorColour(f?.properties?.cls),
          weight: f?.properties?.farthest
            ? SECTOR_FARTHEST_LINE_WIDTH
            : SECTOR_LINE_WIDTH,
          opacity: OVERLAY_OPACITY,
          fill: false,
        }

  // The farthest reception of a class: a small filled dot.
  const farthestDot = (_f: GeoJSON.Feature, at: L.LatLng): L.Layer =>
    L.circleMarker(at, { radius: SECTOR_MAX_RADIUS })

  const view: MapView = {
    element,
    restyle() {
      // Cell and sector colours follow the plotter overlay, not the theme.
    },
    async show(window, units, offsetMin, mode = 'all') {
      lastArgs = [window, units, offsetMin, mode]
      shownWindow = window
      shownMode = mode
      renderModes()
      renderDownloads()
      const g = ++generation
      await ensureMap()
      map!.invalidateSize()
      const trial = trialCap
      const [c, overlay] = await Promise.all([
        get<CoverageResponse>('/coverage', {
          window,
          all: 'true',
          ...(mode === 'all' ? {} : { mode }),
          ...(trial === undefined ? {} : { cap: String(trial) }),
        }),
        get<GeoJSON.FeatureCollection>('/overlay/coverage.geojson').catch(
          () => undefined,
        ),
      ])
      // A later call (a slider move, the minute refresh) has taken over.
      if (g !== generation) return
      if (trial === undefined) savedCap = c.capPercentile
      renderCap()
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
          {
            style: sectorStyle,
            onEachFeature: sectorTip,
            pointToLayer: farthestDot,
          },
        )
      sectorsA = sectorLayer('a')
      sectorsB = sectorLayer('b')
      applyVisibility()
      // The first view frames the cells and the sector wedges of both
      // classes together; the wedges reach past the cells where the p99
      // range exceeds them. The farthest-reception dots can lie far
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
        const which =
          mode === 'all'
            ? ''
            : ` Only cells from reports received while ${mode}; the sectors are for all reports.`
        info.textContent =
          c.cells + c.cappedCells === 0
            ? mode === 'all'
              ? 'No coverage recorded in this window yet.'
              : `No coverage recorded while ${mode} in this window yet.`
            : `${c.cells.toLocaleString()} cells, about ${units.area.format(c.areaM2)} covered.` +
              which +
              beyond +
              ` Basemap: ${current === 'osm' ? 'OpenStreetMap and OpenSeaMap' : 'server charts'}.`
      }
      lastInfo()
    },
  }
  return view
}
