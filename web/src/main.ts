// AIS Statistics web app (SPEC 7): overview, charts, sectors and map as
// custom elements that build their DOM once and update values in place.
// Statistics come from the plugin's REST API; day or night mode, ship time
// and the internet state come over one SignalK WebSocket.
import {
  HttpError,
  get,
  type LongRange,
  type SectorStats,
  type Series,
  type Status,
  type Summary,
} from './api'
import { Chart } from './charts'
import { el, int } from './format'
import { createMap } from './map'
import { SETTINGS_SAVED } from './settings'
import { SectorChart } from './sectors'
import {
  VIEWS,
  WINDOWS,
  formatRoute,
  parseRoute,
  type Route,
  type View,
  type WindowName,
} from './route'
import { connectLive, displayUnits, type LiveState } from './signalk'
import { formatDateTime } from './time'
import { formatPosition, makeUnit, type Unit } from './units'

const COLORS = {
  a: 'var(--color-teal)',
  b: 'var(--color-orange)',
  other: 'var(--color-green)',
  grey: 'var(--color-grey-line)',
}
const GROUP_LABELS: Record<string, string> = {
  cargo: 'Cargo',
  tanker: 'Tanker',
  passenger: 'Passenger',
  fishing: 'Fishing',
  pleasureCraft: 'Pleasure craft',
  other: 'Other',
  unknown: 'Type not yet known',
}
const VIEW_LABELS: Record<View, string> = {
  overview: 'Overview',
  charts: 'Charts',
  sectors: 'Sectors',
  map: 'Map',
}
const DISTANCE_PATH = 'sensors.ais.statistics.distance.p99'
const AREA_PATH = 'sensors.ais.statistics.coverage.area.today'

interface Context {
  window: WindowName
  offsetMin: number | undefined
  units: { distance: Unit; area: Unit }
}

interface ViewElement extends HTMLElement {
  load(ctx: Context): Promise<void>
}

/** A labelled value tile; only its value and note text change. */
class StatTile extends HTMLElement {
  private valueEl?: HTMLElement
  private noteEl?: HTMLElement

  connectedCallback(): void {
    if (this.valueEl) return
    this.classList.add('sk-card', 'stat')
    this.append(
      el('span', { class: 'label' }, this.getAttribute('label') ?? ''),
      (this.valueEl = el('span', { class: 'value' }, '...')),
      (this.noteEl = el(
        'span',
        { class: 'note' },
        this.getAttribute('note') ?? '',
      )),
    )
  }

  set(value: string, note?: string): void {
    if (this.valueEl!.textContent !== value) this.valueEl!.textContent = value
    if (note !== undefined && this.noteEl!.textContent !== note)
      this.noteEl!.textContent = note
  }
}

function tile(label: string, note = ''): StatTile {
  const t = document.createElement('ais-stat') as StatTile
  t.setAttribute('label', label)
  t.setAttribute('note', note)
  return t
}

function sourceText(source: 'history' | 'live', historyError?: string): string {
  if (historyError) return historyError
  return source === 'history'
    ? 'From the server history.'
    : 'From live data held by the plugin (no history provider, or the last hour).'
}

class OverviewView extends HTMLElement implements ViewElement {
  private tiles?: Record<
    | 'messages'
    | 'classA'
    | 'classB'
    | 'vessels'
    | 'p99'
    | 'p95'
    | 'median'
    | 'avg'
    | 'max',
    StatTile
  >
  private groupRows = new Map<
    string,
    { row: HTMLElement; value: HTMLElement }
  >()
  private groupsEmpty?: HTMLElement
  private source?: HTMLElement

  connectedCallback(): void {
    if (this.tiles) return
    const t = {
      messages: tile('Messages'),
      classA: tile('Positions class A'),
      classB: tile('Positions class B'),
      vessels: tile('Vessels'),
      p99: tile('p99', 'typical best case'),
      p95: tile('p95'),
      median: tile('Median'),
      avg: tile('Average'),
      max: tile('Maximum', 'untrusted: one bad position sets it'),
    }
    this.tiles = t
    const groups = el('div', { class: 'groups sk-card' })
    for (const [g, label] of Object.entries(GROUP_LABELS)) {
      const value = el('span', { class: 'num' })
      const row = el(
        'div',
        { class: 'group-row' },
        el('span', {}, label),
        value,
      )
      this.groupRows.set(g, { row, value })
      groups.append(row)
    }
    this.groupsEmpty = el('p', { class: 'muted' }, 'No vessels in this window.')
    this.source = el('p', { class: 'muted small' })
    this.append(
      el('div', { class: 'tiles' }, t.messages, t.classA, t.classB, t.vessels),
      el('h2', {}, 'Distance'),
      el('div', { class: 'tiles' }, t.p99, t.p95, t.median, t.avg, t.max),
      el('h2', {}, 'Vessels by type'),
      groups,
      this.groupsEmpty,
      this.source,
    )
  }

  async load(ctx: Context): Promise<void> {
    const s = await get<Summary>('/summary', { window: ctx.window })
    const t = this.tiles!
    const d = s.distance
    const fmt = (v: number | null) => ctx.units.distance.format(v)
    t.messages.set(int(s.messages))
    t.classA.set(int(s.positions.classA))
    t.classB.set(int(s.positions.classB))
    t.vessels.set(
      s.vessels ? int(s.vessels.total) : 'see charts',
      s.vessels ? '' : 'unique counts do not add up over days',
    )
    t.p99.set(fmt(d.p99M))
    t.p95.set(fmt(d.p95M))
    t.median.set(fmt(d.medianM))
    t.avg.set(fmt(d.avgM))
    t.max.set(fmt(d.maxM))
    let any = false
    for (const [g, { row, value }] of this.groupRows) {
      const n = s.vessels?.byGroup[g] ?? 0
      row.hidden = n === 0
      any ||= n > 0
      value.textContent = int(n)
    }
    this.groupsEmpty!.hidden = any || !s.vessels
    ;(this.querySelector('.groups') as HTMLElement).hidden = !any
    this.source!.textContent = sourceText(s.source, s.historyError)
  }
}

const RESOLUTION: Record<WindowName, number> = {
  '1h': 60,
  '24h': 3600,
  '7d': 3600,
}
const SPAN: Record<WindowName, number> = {
  '1h': 3600e3,
  '24h': 86400e3,
  '7d': 7 * 86400e3,
}

class ChartsView extends HTMLElement implements ViewElement {
  private charts?: {
    positions: Chart
    messages: Chart
    distance: Chart
    max: Chart
    vessels: Chart
  }
  private headings = new Map<string, HTMLElement>()
  private source?: HTMLElement

  connectedCallback(): void {
    if (this.charts) return
    const c = {
      positions: new Chart('bars', [
        { name: 'Class A', color: COLORS.a },
        { name: 'Class B', color: COLORS.b },
        { name: 'Other', color: COLORS.other },
      ]),
      messages: new Chart('line', [{ name: 'Messages', color: COLORS.a }]),
      distance: new Chart('line', [
        { name: 'p99', color: COLORS.a },
        { name: 'p95', color: COLORS.b },
        { name: 'Median', color: COLORS.other },
        { name: 'Average', color: COLORS.grey },
      ]),
      max: new Chart('line', [{ name: 'Maximum', color: COLORS.b }]),
      vessels: new Chart('line', [{ name: 'Vessels', color: COLORS.a }]),
    }
    this.charts = c
    const h = (key: string, tag: 'h2' | 'h3' = 'h2') => {
      const e = el(tag)
      this.headings.set(key, e)
      return e
    }
    this.source = el('p', { class: 'muted small' })
    this.append(
      h('positions'),
      c.positions.element,
      h('messages'),
      c.messages.element,
      h('distance'),
      c.distance.element,
      el('h3', {}, 'Maximum distance (untrusted)'),
      c.max.element,
      h('vessels'),
      c.vessels.element,
      this.source,
    )
  }

  async load(ctx: Context): Promise<void> {
    // Whole minutes, so reloads within a minute reuse the server's answer.
    const to = new Date(Math.floor(Date.now() / 60_000) * 60_000)
    const params = {
      resolution: String(RESOLUTION[ctx.window]),
      from: new Date(to.getTime() - SPAN[ctx.window]).toISOString(),
      to: to.toISOString(),
    }
    const [pos, msg, dist, ves] = await Promise.all([
      get<Series>('/series', { ...params, metric: 'positions' }),
      get<Series>('/series', { ...params, metric: 'messages' }),
      get<Series>('/series', { ...params, metric: 'distance' }),
      get<Series>('/series', { ...params, metric: 'vessels' }),
    ])
    const col = (s: Series, k: string) => (s[k] as (number | null)[]) ?? []
    const times = (s: Series) => s.times.map((t) => Date.parse(t))
    const count = (v: number) => Math.round(v).toLocaleString()
    const u = ctx.units.distance
    const conv = (s: Series, k: string) =>
      col(s, k).map((v) => (v === null ? null : u.toDisplay(v)))
    const per =
      pos.resolution >= 86400
        ? 'day'
        : pos.resolution >= 3600
          ? 'hour'
          : 'minute'
    const c = this.charts!
    this.headings.get('positions')!.textContent = `Positions per ${per}`
    this.headings.get('messages')!.textContent = `Messages per ${per}`
    this.headings.get('distance')!.textContent = `Distance per ${per}`
    this.headings.get('vessels')!.textContent =
      ves.resolution >= 86400
        ? 'Unique vessels per day'
        : 'Unique vessels in the past hour'
    const base = { offsetMin: ctx.offsetMin }
    c.positions.update({
      ...base,
      times: times(pos),
      columns: [col(pos, 'classA'), col(pos, 'classB'), col(pos, 'other')],
      format: count,
    })
    c.messages.update({
      ...base,
      times: times(msg),
      columns: [col(msg, 'messages')],
      format: count,
    })
    c.distance.update({
      ...base,
      times: times(dist),
      columns: [
        conv(dist, 'p99M'),
        conv(dist, 'p95M'),
        conv(dist, 'medianM'),
        conv(dist, 'avgM'),
      ],
      format: u.formatDisplay,
    })
    c.max.update({
      ...base,
      times: times(dist),
      columns: [conv(dist, 'maxM')],
      format: u.formatDisplay,
    })
    c.vessels.update({
      ...base,
      times: times(ves),
      columns: [col(ves, 'vessels')],
      format: count,
    })
    this.source!.textContent = sourceText(pos.source, pos.historyError)
  }
}

class SectorsView extends HTMLElement implements ViewElement {
  private a?: SectorChart
  private b?: SectorChart
  private source?: HTMLElement
  private longRange?: HTMLTableSectionElement
  private longRangeEmpty?: HTMLElement

  connectedCallback(): void {
    if (this.a) return
    this.a = new SectorChart(COLORS.a)
    this.b = new SectorChart(COLORS.b)
    this.source = el('p', { class: 'muted small' })
    this.append(
      el(
        'p',
        { class: 'muted small' },
        'Radius per 15° sector: the highest hourly p99 distance in the window, from hours with at least 20 reports in the sector. The thin tick reaches out to the farthest reception.',
      ),
      el(
        'div',
        { class: 'sector-charts' },
        el(
          'div',
          { class: 'sk-card' },
          el('h2', {}, 'Class A'),
          this.a.element,
        ),
        el(
          'div',
          { class: 'sk-card' },
          el('h2', {}, 'Class B'),
          this.b.element,
        ),
      ),
      this.source,
    )
    this.longRange = el('tbody')
    this.longRangeEmpty = el(
      'p',
      { class: 'muted small' },
      'No positions with a known own position in this window yet.',
    )
    const head = el('tr')
    for (const [label, num] of [
      ['Time', false],
      ['Distance', true],
      ['Bearing', true],
      ['Class', false],
      ['Vessel', false],
      ['Its position', false],
      ['Own position', false],
    ] as const)
      head.append(el('th', num ? { class: 'num' } : {}, label))
    this.append(
      el(
        'div',
        { class: 'sk-card' },
        el('h2', {}, 'Farthest receptions'),
        el(
          'p',
          { class: 'muted small' },
          'The farthest position of each vessel per day. Far outliers can be real propagation (ducting, sporadic E) or a wrong position sent by the vessel.',
        ),
        el(
          'div',
          { class: 'long-range' },
          el('table', {}, el('thead', {}, head), this.longRange),
        ),
        this.longRangeEmpty,
      ),
    )
  }

  async load(ctx: Context): Promise<void> {
    const [a, b, lr] = await Promise.all([
      get<SectorStats>('/sectors', { window: ctx.window, class: 'a' }),
      get<SectorStats>('/sectors', { window: ctx.window, class: 'b' }),
      get<LongRange>('/longrange', {
        window: ctx.window === '1h' ? '24h' : ctx.window,
      }).catch(() => ({ entries: [] }) as LongRange),
    ])
    this.a!.update(a, ctx.units.distance, ctx.offsetMin)
    this.b!.update(b, ctx.units.distance, ctx.offsetMin)
    this.source!.textContent = sourceText(a.source, a.historyError)
    const u = ctx.units.distance
    this.longRange!.replaceChildren(
      ...lr.entries.map((e) => {
        const cell = (text: string, num = false) =>
          el('td', num ? { class: 'num' } : {}, text)
        return el(
          'tr',
          {},
          cell(formatDateTime(Date.parse(e.time), ctx.offsetMin)),
          cell(u.format(e.distanceM), true),
          cell(`${Math.round(e.bearingDeg)}°`, true),
          cell(e.cls),
          cell(e.name ? `${e.name} (${e.mmsi})` : e.mmsi),
          cell(formatPosition(e.lat, e.lon)),
          cell(formatPosition(e.ownLat, e.ownLon)),
        )
      }),
    )
    this.longRangeEmpty!.hidden = lr.entries.length > 0
  }
}

const mapView = createMap()

class MapViewElement extends HTMLElement implements ViewElement {
  connectedCallback(): void {
    if (!this.contains(mapView.element)) this.append(mapView.element)
  }

  async load(ctx: Context): Promise<void> {
    await mapView.show(
      ctx.window === '1h' ? '24h' : ctx.window,
      ctx.units,
      ctx.offsetMin,
    )
  }
}

customElements.define('ais-stat', StatTile)
customElements.define('ais-overview', OverviewView)
customElements.define('ais-charts', ChartsView)
customElements.define('ais-sectors', SectorsView)
customElements.define('ais-map', MapViewElement)

// Shell: header, offline banner, tabs, window selector and the views.
const app = document.getElementById('app')!
const statusLine = el('p', { class: 'status muted' })
const banner = el('div', { class: 'banner theme-offline', hidden: '' })
const nav = el('nav', { class: 'tabs' })
const windows = el('nav', { class: 'segmented', 'aria-label': 'Window' })
const error = el('p', { class: 'error theme-red', hidden: '' })
const settingsBody = el('tbody')
const settings = el(
  'details',
  { class: 'settings' },
  el('summary', {}, 'Settings'),
  el(
    'p',
    { class: 'muted small' },
    'The settings in effect, read only. Change them in the server admin under Server, Plugin Config, AIS Statistics. The coverage distance cap can also be tried and saved on the map.',
  ),
  el('table', {}, settingsBody),
)
const views = Object.fromEntries(
  VIEWS.map((v) => [v, el(`ais-${v}` as 'div', { hidden: '' })]),
) as unknown as Record<View, ViewElement>
const tabLinks = new Map<View, HTMLAnchorElement>()
const windowLinks = new Map<WindowName, HTMLAnchorElement>()
for (const v of VIEWS) {
  const a = el('a', { href: '#' }, VIEW_LABELS[v])
  tabLinks.set(v, a)
  nav.append(a)
}
for (const w of WINDOWS) {
  const a = el('a', { href: '#' }, w)
  windowLinks.set(w, a)
  windows.append(a)
}
app.append(
  el(
    'header',
    {},
    el('img', { src: 'icon.png', alt: '', class: 'logo' }),
    el('h1', {}, 'AIS Statistics'),
  ),
  statusLine,
  banner,
  nav,
  windows,
  error,
  el('main', {}, ...VIEWS.map((v) => views[v])),
  settings,
)

let live: LiveState = {
  connected: false,
  retryInS: null,
  mode: 'day',
  offsetMin: undefined,
  internet: undefined,
}
let units = {
  distance: makeUnit('m', undefined),
  area: makeUnit('m2', undefined),
}
let unitsKnown = false
let route: Route = parseRoute(location.hash)

async function loadUnits(): Promise<void> {
  if (unitsKnown) return
  const [d, a] = await Promise.all([
    displayUnits(DISTANCE_PATH),
    displayUnits(AREA_PATH),
  ])
  units = { distance: makeUnit('m', d), area: makeUnit('m2', a) }
  // The paths exist only after the first publish; ask again until then.
  unitsKnown = d !== undefined
}

function describe(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403))
    return 'Please log in to the SignalK server to see the statistics.'
  if (err instanceof HttpError && err.status === 503)
    return 'The plugin is not running.'
  return `Could not load: ${err instanceof Error ? err.message : String(err)}`
}

/** Names of the settings as the server's config form shows them. */
const SETTING_LABELS: Record<string, string> = {
  sentenceEvents: 'Server events read',
  publishIntervalMinutes: 'Publish interval (minutes)',
  coverageDistancePercentile: 'Coverage distance cap (percentile)',
  h3Resolution: 'Coverage cell resolution (H3)',
  coverageRetentionDays: 'Coverage retention (days)',
  targetExpirySeconds: 'Target expiry (seconds)',
  ownPositionMaxAgeSeconds: 'Own position maximum age (seconds)',
  publishOverlay: 'Plotter overlay',
}

function renderSettings(config: Record<string, unknown> | undefined): void {
  settings.hidden = !config
  if (!config) return
  const value = (v: unknown) =>
    Array.isArray(v)
      ? v.join(', ')
      : typeof v === 'boolean'
        ? v
          ? 'on'
          : 'off'
        : String(v)
  const keys = [
    ...Object.keys(SETTING_LABELS).filter((k) => k in config),
    ...Object.keys(config).filter((k) => !(k in SETTING_LABELS)),
  ]
  settingsBody.replaceChildren(
    ...keys.map((k) =>
      el(
        'tr',
        {},
        el('th', { scope: 'row' }, SETTING_LABELS[k] ?? k),
        el('td', {}, value(config[k])),
      ),
    ),
  )
}

async function updateStatus(): Promise<void> {
  try {
    const s = await get<Status>('/status')
    renderSettings(s.running ? s.config : undefined)
    statusLine.textContent = !s.running
      ? 'The plugin is not running.'
      : s.noData
        ? 'No AIS data received since the plugin started.'
        : `${s.trackedTargets ?? 0} targets tracked. Own position ${s.ownPositionFresh ? 'known' : 'unknown or stale, so distances are not counted'}. History ${s.historyAvailable ? 'available' : 'not available, showing live data only'}.` +
          (s.lastMessageAt
            ? ` Last message ${formatDateTime(Date.parse(s.lastMessageAt), live.offsetMin)}.`
            : '')
  } catch (err) {
    statusLine.textContent = describe(err)
  }
}

function renderNav(): void {
  for (const [v, a] of tabLinks) {
    a.href = formatRoute({ view: v, window: route.window })
    a.toggleAttribute('aria-current', v === route.view)
  }
  for (const [w, a] of windowLinks) {
    const hidden = route.view === 'map' && w === '1h'
    a.hidden = hidden
    a.href = formatRoute({ view: route.view, window: w })
    a.textContent = route.view === 'map' && w === '24h' ? 'Today' : w
    a.toggleAttribute('aria-current', w === route.window)
  }
  for (const v of VIEWS) views[v].hidden = v !== route.view
}

let generation = 0
async function render(): Promise<void> {
  const g = ++generation
  renderNav()
  try {
    await loadUnits()
    await views[route.view].load({
      window: route.window,
      offsetMin: live.offsetMin,
      units,
    })
    if (g === generation) error.hidden = true
  } catch (err) {
    if (g !== generation) return
    error.textContent = describe(err)
    error.hidden = false
  }
}

function renderLive(): void {
  document.documentElement.dataset.mode = live.mode
  mapView.restyle()
  banner.hidden = live.connected
  banner.textContent =
    live.retryInS === null
      ? 'Connecting to the SignalK server...'
      : `Connection to the SignalK server lost. Retrying in ${live.retryInS} s.`
}

window.addEventListener(SETTINGS_SAVED, () => void updateStatus())

window.addEventListener('hashchange', () => {
  route = parseRoute(location.hash)
  void render()
})

connectLive((s) => {
  const offsetChanged = s.offsetMin !== live.offsetMin
  live = s
  renderLive()
  if (offsetChanged) {
    void updateStatus()
    void render()
  }
})

void updateStatus()
void render()
// Statistics change at most once a minute; poll while the tab is visible.
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  void updateStatus()
  void render()
}, 60_000)
