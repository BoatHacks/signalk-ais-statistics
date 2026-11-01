// AIS Statistics web app (SPEC 7): overview, charts, sectors and map as
// custom elements that build their DOM once and update values in place.
// Statistics come from the plugin's REST API; day or night mode, ship time
// and the internet state come over one SignalK WebSocket.
import {
  HttpError,
  exportHref,
  get,
  type CoverageResponse,
  type FastEntry,
  type LongRange,
  type SectorStats,
  type SourceInfo,
  type Series,
  type Weather,
  type Status,
  type Summary,
} from './api'
import { Chart } from './charts'
import { WeatherPanel } from './weather'
import { el, int } from './format'
import {
  classMix,
  duplicateHint,
  formatShare,
  goodShare,
  share,
  type HealthKind,
} from './health'
import { createMap } from './map'
import { downloadLink, setLink } from './downloads'
import { SETTINGS_SAVED } from './settings'
import { showLoading } from './loading'
import { SectorChart, sectorScale } from './sectors'
import {
  MAX_COMPARE_DAYS,
  VIEWS,
  WINDOWS,
  defaultCompare,
  formatRoute,
  parseRoute,
  type CompareParams,
  type Route,
  type View,
  type WindowName,
} from './route'
import {
  beforeRetention,
  change,
  compareWindows,
  formatRatio,
  signed,
  type CompareWindow,
} from './compare'
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
  compare: 'Compare',
}
const DISTANCE_PATH = 'sensors.ais.statistics.distance.p99'
const AREA_PATH = 'sensors.ais.statistics.coverage.area.today'
/** Speeds follow the server's unit preference for speed over ground. */
const SPEED_PATH = 'navigation.speedOverGround'
const HEALTH_LABELS: Record<HealthKind, string> = {
  decodeErrors: 'Undecodable',
  incomplete: 'Incomplete (part missing)',
  duplicates: 'Duplicates',
  duplicatesCrossEvent: 'Duplicates across events',
  positionInvalid: 'Invalid positions',
  implausibleJumps: 'Implausible jumps',
  noOwnPosition: 'Without own position',
}

interface Context {
  window: WindowName
  compare?: CompareParams
  offsetMin: number | undefined
  units: { distance: Unit; area: Unit; speed: Unit }
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
  private healthLine?: HTMLElement
  private healthHint?: HTMLElement
  private healthRows = new Map<HealthKind, HTMLElement>()

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
    this.healthLine = el('p', { class: 'health-line' })
    this.healthHint = el('p', { class: 'hint theme-orange', hidden: '' }, '')
    const health = el('div', { class: 'groups sk-card' })
    for (const k of Object.keys(HEALTH_LABELS) as HealthKind[]) {
      const value = el('span', { class: 'num' })
      health.append(
        el(
          'div',
          { class: 'group-row' },
          el('span', {}, HEALTH_LABELS[k]),
          value,
        ),
      )
      this.healthRows.set(k, value)
    }
    this.append(
      el('div', { class: 'tiles' }, t.messages, t.classA, t.classB, t.vessels),
      el('h2', {}, 'Distance'),
      el('div', { class: 'tiles' }, t.p99, t.p95, t.median, t.avg, t.max),
      el('h2', {}, 'Vessels by type'),
      groups,
      this.groupsEmpty,
      el('h2', {}, 'Message health'),
      this.healthLine,
      this.healthHint,
      health,
      el(
        'p',
        { class: 'muted small' },
        'Counted only: duplicates, jumps and the rest still count everywhere else. A jump is a position implying a speed above the limit for the sender; one bad position counts twice, out and back.',
      ),
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
    const h = s.health
    this.healthLine!.textContent =
      h.received > 0
        ? `${formatShare(goodShare(h))} of ${int(h.received)} received messages are good: decodable, complete, not a copy, and with a usable position.`
        : 'No messages received in this window.'
    // With per-source statistics on, copies across events are receiver
    // overlap, not a fault; the hint then counts same-event copies only.
    this.healthHint!.hidden = !duplicateHint(h, perSourceStats)
    this.healthHint!.textContent = perSourceStats
      ? 'Many messages arrive twice on the same server event. A receiver may be connected twice, or a multiplexer may repeat its input.'
      : 'Many messages arrive twice. One receiver may reach two of the configured server events (Server events to read AIS from); remove one of them. If two receivers are meant to overlap, turn on Statistics per server event.'
    for (const [k, value] of this.healthRows)
      value.textContent = `${int(h.counts[k])} (${formatShare(share(h.counts[k], h.received))})`
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
    mix: Chart
    health: Chart
  }
  private headings = new Map<string, HTMLElement>()
  private source?: HTMLElement
  private weather?: WeatherPanel

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
      mix: new Chart('bars', [
        { name: 'Class A', color: COLORS.a },
        { name: 'Class B', color: COLORS.b },
      ]),
      health: new Chart('line', [
        { name: 'Undecodable', color: 'var(--color-red)' },
        { name: 'Duplicates', color: COLORS.b },
        { name: 'Across events', color: COLORS.a },
        { name: 'Invalid positions', color: COLORS.grey },
        { name: 'Jumps', color: COLORS.other },
      ]),
    }
    this.charts = c
    this.weather = new WeatherPanel(COLORS.a, COLORS.b)
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
      el('h2', {}, 'Class A and B mix'),
      c.mix.element,
      h('health'),
      c.health.element,
      this.weather.element,
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
    const shortWindow = RESOLUTION[ctx.window] < 3600
    const [pos, msg, dist, ves, hl, weather] = await Promise.all([
      get<Series>('/series', { ...params, metric: 'positions' }),
      get<Series>('/series', { ...params, metric: 'messages' }),
      get<Series>('/series', { ...params, metric: 'distance' }),
      get<Series>('/series', { ...params, metric: 'vessels' }),
      get<Series>('/series', { ...params, metric: 'health' }),
      // Hourly weather pairs with hourly range, so only from 24h up. A
      // failed weather read hides the panel, not the charts.
      shortWindow
        ? Promise.resolve(null)
        : get<Weather>('/weather', { from: params.from, to: params.to }).catch(
            () => null,
          ),
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
    this.headings.get('health')!.textContent =
      `Message health: share of received messages per ${per}`
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
    const mix = classMix(col(pos, 'classA'), col(pos, 'classB'))
    const pct = (v: number) => `${Math.round(v * 100)} %`
    c.mix.update({
      ...base,
      times: times(pos),
      columns: [mix.a, mix.b],
      format: pct,
    })
    const received = col(hl, 'received')
    const shares = (...kinds: HealthKind[]) =>
      received.map((r, i) => {
        let n = 0
        for (const k of kinds) n += col(hl, k)[i] ?? 0
        return r === null ? null : share(n, r)
      })
    c.health.update({
      ...base,
      times: times(hl),
      columns: [
        shares('decodeErrors', 'incomplete'),
        shares('duplicates'),
        shares('duplicatesCrossEvent'),
        shares('positionInvalid'),
        shares('implausibleJumps'),
      ],
      format: (v) => formatShare(v),
    })
    this.source!.textContent = sourceText(pos.source, pos.historyError)
    await this.weather!.update({
      distance: dist,
      weather,
      shortWindow,
      distanceUnit: u,
      offsetMin: ctx.offsetMin,
    })
  }
}

class SectorsView extends HTMLElement implements ViewElement {
  private a?: SectorChart
  private b?: SectorChart
  private source?: HTMLElement
  private longRange?: HTMLTableSectionElement
  private longRangeEmpty?: HTMLElement
  private fastest?: SpeedTable
  private jumps?: SpeedTable
  private renderDownloads?: (window: '24h' | '7d') => void

  connectedCallback(): void {
    if (this.a) return
    this.a = new SectorChart(COLORS.a)
    this.b = new SectorChart(COLORS.b)
    this.source = el('p', { class: 'muted small' })
    this.append(
      el(
        'p',
        { class: 'muted small' },
        'Radius per 15° sector: the highest hourly p99 distance in the window, from hours with at least 20 reports in the sector. Each thin tick runs from the centre to a dot at the farthest reception in its sector; the broader tick marks the farthest reception of the chart.',
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
        this.downloads(),
      ),
    )
    this.fastest = new SpeedTable(
      'Fastest vessels',
      'The highest plausible speed of each sender per day, implied by two of its positions at least 500 m apart, beside the speed it reported.',
      'No sender moved far enough in this window to measure its speed.',
    )
    this.jumps = new SpeedTable(
      'Implausible jumps',
      'The fastest jumps above the limit for the sender: most likely a wrong position rather than a fast craft. Kept apart so they cannot push real fast craft out of the list above.',
      'No implausible jumps in this window.',
    )
    this.append(this.fastest.element, this.jumps.element)
  }

  private downloads(): HTMLElement {
    const d = longRangeDownloads()
    this.renderDownloads = d.render
    return d.element
  }

  async load(ctx: Context): Promise<void> {
    const [a, b, lr] = await Promise.all([
      get<SectorStats>('/sectors', { window: ctx.window, class: 'a' }),
      get<SectorStats>('/sectors', { window: ctx.window, class: 'b' }),
      get<LongRange>('/longrange', {
        window: ctx.window === '1h' ? '24h' : ctx.window,
      }).catch(
        () => ({ entries: [], fastest: [], implausibleJumps: [] }) as LongRange,
      ),
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
    this.renderDownloads!(ctx.window === '1h' ? '24h' : ctx.window)
    this.fastest!.update(lr.fastest ?? [], ctx)
    this.jumps!.update(lr.implausibleJumps ?? [], ctx)
  }
}

/**
 * Downloads of every farthest reception in the table's window and in all
 * retained days, as CSV or GeoJSON. Anonymise drops MMSIs, names and
 * positions, which leaves nothing to map, so GeoJSON is then greyed out.
 */
function longRangeDownloads(): {
  element: HTMLElement
  render: (window: '24h' | '7d') => void
} {
  const csvWindow = downloadLink('CSV')
  const geoWindow = downloadLink('GeoJSON')
  const csvAll = downloadLink('CSV, all days')
  const geoAll = downloadLink('GeoJSON, all days')
  const anon = el('input', { type: 'checkbox', id: 'export-anonymise' })
  let window: '24h' | '7d' = '24h'
  const render = (w: '24h' | '7d' = window) => {
    window = w
    const anonymise = anon.checked
    setLink(csvWindow, exportHref('longrange.csv', w, { anonymise }))
    setLink(csvAll, exportHref('longrange.csv', 'all', { anonymise }))
    const noMap = 'Anonymised exports have no positions: CSV only.'
    setLink(
      geoWindow,
      anonymise ? undefined : exportHref('longrange.geojson', w),
      noMap,
    )
    setLink(
      geoAll,
      anonymise ? undefined : exportHref('longrange.geojson', 'all'),
      noMap,
    )
  }
  anon.addEventListener('change', () => render())
  render()
  const element = el(
    'div',
    {},
    el(
      'div',
      {
        class: 'downloads',
        role: 'group',
        'aria-label': 'Download receptions',
      },
      el('span', { class: 'downloads-label' }, 'Download'),
      csvWindow,
      geoWindow,
      csvAll,
      geoAll,
      el(
        'label',
        { class: 'downloads-check', for: 'export-anonymise' },
        anon,
        'Anonymise',
      ),
    ),
    el(
      'p',
      { class: 'muted small' },
      'Every entry in the window, not only the farthest shown. Anonymise leaves out MMSIs, names and all positions, keeping time, class, ship type, distance and bearing.',
    ),
  )
  return { element, render }
}

/** A card with a table of implied speeds (SPEC 2.8). */
class SpeedTable {
  readonly element: HTMLElement
  private readonly body = el('tbody')
  private readonly empty: HTMLElement

  constructor(title: string, note: string, emptyText: string) {
    this.empty = el('p', { class: 'muted small' }, emptyText)
    const head = el('tr')
    for (const [label, num] of [
      ['Time', false],
      ['Implied speed', true],
      ['Reported SOG', true],
      ['Limit', true],
      ['Over', true],
      ['Class', false],
      ['Vessel', false],
      ['From', false],
      ['To', false],
    ] as const)
      head.append(el('th', num ? { class: 'num' } : {}, label))
    this.element = el(
      'div',
      { class: 'sk-card' },
      el('h2', {}, title),
      el('p', { class: 'muted small' }, note),
      el(
        'div',
        { class: 'long-range' },
        el('table', {}, el('thead', {}, head), this.body),
      ),
      this.empty,
    )
  }

  update(entries: FastEntry[], ctx: Context): void {
    const v = ctx.units.speed
    const cell = (text: string, num = false) =>
      el('td', num ? { class: 'num' } : {}, text)
    this.body.replaceChildren(
      ...entries.map((e) =>
        el(
          'tr',
          // Rows in the class colours of the sectors view.
          { class: `cls-${e.cls.toLowerCase()}` },
          cell(formatDateTime(Date.parse(e.time), ctx.offsetMin)),
          cell(v.format(e.speedMps), true),
          cell(e.sogMps === undefined ? '–' : v.format(e.sogMps), true),
          cell(v.format(e.limitMps), true),
          cell(`${Math.round(e.gapS)} s`, true),
          cell(e.cls),
          cell(e.name ? `${e.name} (${e.mmsi})` : e.mmsi),
          cell(formatPosition(e.fromLat, e.fromLon)),
          cell(formatPosition(e.lat, e.lon)),
        ),
      ),
    )
    this.empty.hidden = entries.length > 0
  }
}

type CompareKind = 'count' | 'distance' | 'area' | 'cells'

interface CompareRow {
  label: string
  kind: CompareKind
  before: HTMLElement
  after: HTMLElement
  change: HTMLElement
}

/**
 * Two date windows side by side (SPEC 7), to tell whether an antenna,
 * cable or receiver change helped. The windows are UTC days; their state
 * lives in the hash, not in the plugin config.
 */
class CompareView extends HTMLElement implements ViewElement {
  private date?: HTMLInputElement
  private days?: HTMLSelectElement
  private source?: HTMLSelectElement
  private sourceControl?: HTMLElement
  private sourceList = ''
  private heads?: { before: HTMLElement; after: HTMLElement }
  private rows = new Map<string, CompareRow>()
  private charts?: { before: SectorChart; after: SectorChart }
  private chartHeads?: { before: HTMLElement; after: HTMLElement }
  private notes?: HTMLElement

  connectedCallback(): void {
    if (this.date) return
    this.date = el('input', { type: 'date', id: 'compare-date' })
    this.days = el('select', { id: 'compare-days' })
    for (let d = 1; d <= MAX_COMPARE_DAYS; d++)
      this.days.append(el('option', { value: String(d) }, `${d} d`))
    const go = () => {
      const days = Number(this.days!.value)
      if (!this.date!.value) return
      location.hash = formatRoute({
        view: 'compare',
        window: route.window,
        compare: {
          date: this.date!.value,
          days,
          source: this.source!.value || 'all',
        },
      })
    }
    this.date.addEventListener('change', go)
    this.days.addEventListener('change', go)
    this.source = el('select', { id: 'compare-source' })
    this.source.addEventListener('change', go)
    // Shown only while per-source statistics are on.
    this.sourceControl = el(
      'span',
      { class: 'compare-source', hidden: '' },
      el('label', { for: 'compare-source' }, 'Source'),
      this.source,
    )
    this.heads = {
      before: el('th', { class: 'num' }),
      after: el('th', { class: 'num' }),
    }
    const head = el(
      'tr',
      {},
      el('th', {}, ''),
      this.heads.before,
      this.heads.after,
      el('th', { class: 'num' }, 'Change'),
    )
    const body = el('tbody')
    const add = (key: string, label: string, kind: CompareKind) => {
      const row: CompareRow = {
        label,
        kind,
        before: el('td', { class: 'num' }),
        after: el('td', { class: 'num' }),
        change: el('td', { class: 'num' }),
      }
      this.rows.set(key, row)
      body.append(
        el(
          'tr',
          {},
          el('th', { scope: 'row' }, label),
          row.before,
          row.after,
          row.change,
        ),
      )
    }
    add('messages', 'Messages', 'count')
    add('classA', 'Positions class A', 'count')
    add('classB', 'Positions class B', 'count')
    add('other', 'Positions other', 'count')
    add('p99', 'Distance p99', 'distance')
    add('p95', 'Distance p95', 'distance')
    add('median', 'Distance median', 'distance')
    add('avg', 'Distance average', 'distance')
    add('max', 'Distance maximum (untrusted)', 'distance')
    add('cells', 'Coverage cells', 'cells')
    add('area', 'Coverage area', 'area')
    this.charts = {
      before: new SectorChart(COLORS.a),
      after: new SectorChart(COLORS.b),
    }
    this.chartHeads = { before: el('h2'), after: el('h2') }
    this.notes = el('div', { class: 'compare-notes' })
    this.append(
      el(
        'p',
        { class: 'muted small' },
        'Two windows of whole UTC days side by side: the days before the date and the days from the date on, for example before and after an antenna, cable or receiver change. Counts are compared per hour when the after window is shorter because it reaches today.',
      ),
      el(
        'div',
        { class: 'compare-controls' },
        el('label', { for: 'compare-date' }, 'Change on'),
        this.date,
        el('label', { for: 'compare-days' }, 'Days each side'),
        this.days,
        this.sourceControl,
      ),
      el(
        'div',
        { class: 'sk-card long-range' },
        el('table', { class: 'compare' }, el('thead', {}, head), body),
      ),
      this.notes,
      el('h2', {}, 'Sectors, all classes'),
      el(
        'div',
        { class: 'sector-charts' },
        el(
          'div',
          { class: 'sk-card' },
          this.chartHeads.before,
          this.charts.before.element,
        ),
        el(
          'div',
          { class: 'sk-card' },
          this.chartHeads.after,
          this.charts.after.element,
        ),
      ),
      el(
        'p',
        { class: 'muted small' },
        'Both charts share one scale. Radius per 15° sector: the highest hourly p99 distance, from hours with at least 20 reports in the sector.',
      ),
    )
  }

  /** The source picker: all, then each counted event. */
  private renderSources(sources: SourceInfo[], selected: string): void {
    const key = sources.map((x) => x.label).join(',')
    if (key !== this.sourceList) {
      this.sourceList = key
      this.source!.replaceChildren(
        el('option', { value: 'all' }, 'All sources'),
        ...sources.map((x) => el('option', { value: x.label }, x.event)),
      )
    }
    this.sourceControl!.hidden = sources.length === 0
    this.source!.value = sources.some((x) => x.label === selected)
      ? selected
      : 'all'
  }

  async load(ctx: Context): Promise<void> {
    const c = ctx.compare ?? defaultCompare(Date.now())
    const now = Date.now()
    this.date!.value = c.date
    this.date!.max = new Date(now).toISOString().slice(0, 10)
    this.days!.value = String(c.days)
    const { before, after } = compareWindows(c, now)
    const { sources } = await get<{ sources: SourceInfo[] }>('/sources')
    this.renderSources(sources, c.source)
    // A source that is not counted (any more) falls back to all of them.
    const source = sources.some((x) => x.label === c.source) ? c.source : 'all'
    const range = (w: CompareWindow) => ({
      from: new Date(w.from).toISOString(),
      to: new Date(w.to).toISOString(),
    })
    const bySource: Record<string, string> = source === 'all' ? {} : { source }
    const days = (w: CompareWindow) => ({ from: w.fromDay, to: w.toDay })
    const [sb, sa, xb, xa, cb, ca] = await Promise.all([
      get<Summary>('/summary', { ...range(before), ...bySource }),
      get<Summary>('/summary', { ...range(after), ...bySource }),
      get<SectorStats>('/sectors', { ...range(before), class: 'all' }),
      get<SectorStats>('/sectors', { ...range(after), class: 'all' }),
      get<CoverageResponse>('/coverage', days(before)),
      get<CoverageResponse>('/coverage', days(after)),
    ])
    const label = (w: CompareWindow) =>
      w.fromDay === w.toDay ? w.fromDay : `${w.fromDay} to ${w.toDay}`
    // Two lines, so the table fits a phone.
    this.heads!.before.replaceChildren('Before', el('br'), label(before))
    this.heads!.after.replaceChildren('After', el('br'), label(after))
    this.chartHeads!.before.textContent = `Before, ${label(before)}`
    this.chartHeads!.after.textContent = `After, ${label(after)}`

    const coverageKept = {
      before: !beforeRetention(before, cb.retainedFrom),
      after: !beforeRetention(after, ca.retainedFrom),
    }
    const hours = { before: before.hours, after: after.hours }
    const values: Record<string, [number | null, number | null]> = {
      messages: [sb.messages, sa.messages],
      classA: [sb.positions.classA, sa.positions.classA],
      classB: [sb.positions.classB, sa.positions.classB],
      other: [sb.positions.other, sa.positions.other],
      p99: [sb.distance.p99M, sa.distance.p99M],
      p95: [sb.distance.p95M, sa.distance.p95M],
      median: [sb.distance.medianM, sa.distance.medianM],
      avg: [sb.distance.avgM, sa.distance.avgM],
      max: [sb.distance.maxM, sa.distance.maxM],
      cells: [
        coverageKept.before ? cb.cells : null,
        coverageKept.after ? ca.cells : null,
      ],
      area: [
        coverageKept.before ? cb.areaM2 : null,
        coverageKept.after ? ca.areaM2 : null,
      ],
    }
    const u = ctx.units
    for (const [key, row] of this.rows) {
      const [b, a] = values[key]!
      const fmt = (v: number | null): string => {
        if (v === null)
          return row.kind === 'cells' || row.kind === 'area'
            ? 'not kept'
            : 'no data'
        if (row.kind === 'distance') return u.distance.format(v)
        if (row.kind === 'area') return u.area.format(v)
        return int(v)
      }
      row.before.textContent = fmt(b)
      row.after.textContent = fmt(a)
      const ch = change(b, a, row.kind === 'count' ? hours : undefined)
      const abs = (v: number) =>
        row.kind === 'distance'
          ? u.distance.format(v)
          : row.kind === 'area'
            ? u.area.format(v)
            : int(v)
      row.change.textContent = ch
        ? `${signed(ch.delta, abs)} (${formatRatio(ch.ratio)})`
        : '–'
    }

    const scale = Math.max(sectorScale(xb), sectorScale(xa))
    this.charts!.before.update(xb, u.distance, ctx.offsetMin, scale)
    this.charts!.after.update(xa, u.distance, ctx.offsetMin, scale)

    const notes: string[] = []
    if (after.hours < before.hours)
      notes.push(
        `The after window reaches now, so it has ${after.hours} of ${before.hours} hours; counts are compared per hour.`,
      )
    for (const [name, s] of [
      ['before', sb],
      ['after', sa],
    ] as const) {
      if (s.historyError) notes.push(s.historyError)
      else if (s.liveFrom)
        notes.push(
          `There is no history provider, so the ${name} window has live data only from ${formatDateTime(Date.parse(s.liveFrom), ctx.offsetMin)}.`,
        )
    }
    if (!coverageKept.before || !coverageKept.after)
      notes.push(
        `Coverage is kept from ${cb.retainedFrom} on (Coverage retention in the plugin settings), so it is not compared for a window that starts earlier.`,
      )
    if (source !== 'all')
      notes.push(
        `The table counts what the ${sources.find((x) => x.label === source)!.event} server event delivered; its maximum distance is known from live data only. The sectors and coverage below are for all sources.`,
      )
    if (sb.source === 'history' && sa.source === 'history')
      notes.push('From the server history.')
    this.notes!.replaceChildren(
      ...notes.map((n) => el('p', { class: 'muted small' }, n)),
    )
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
customElements.define('ais-compare', CompareView)

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
/** The link the user clicked, which shows the load it starts. */
let clicked: HTMLAnchorElement | undefined
for (const v of VIEWS) {
  const a = el('a', { href: '#' }, VIEW_LABELS[v])
  a.addEventListener('click', () => (clicked = a))
  tabLinks.set(v, a)
  nav.append(a)
}
for (const w of WINDOWS) {
  const a = el('a', { href: '#' }, w)
  a.addEventListener('click', () => (clicked = a))
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
  speed: makeUnit('m/s', undefined),
}
let unitsKnown = false
let route: Route = parseRoute(location.hash)

async function loadUnits(): Promise<void> {
  if (unitsKnown) return
  const [d, a, v] = await Promise.all([
    displayUnits(DISTANCE_PATH),
    displayUnits(AREA_PATH),
    displayUnits(SPEED_PATH),
  ])
  units = {
    distance: makeUnit('m', d),
    area: makeUnit('m2', a),
    speed: makeUnit('m/s', v),
  }
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
  jumpSpeedLimitKnots: 'Implausible jump speed (knots)',
  jumpSpeedLimitHighSpeedKnots: 'Jump speed, high-speed and WIG craft (knots)',
  jumpSpeedLimitAircraftKnots: 'Jump speed, SAR aircraft (knots)',
  weatherPaths: 'Weather paths (range vs weather)',
  sourceStatistics: 'Statistics per server event',
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

/** Whether the plugin counts per server event, from its status. */
let perSourceStats = false

async function updateStatus(): Promise<void> {
  try {
    const s = await get<Status>('/status')
    perSourceStats = s.config?.sourceStatistics === true
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
    a.href = formatRoute({
      view: v,
      window: route.window,
      ...(v === 'compare' && route.compare ? { compare: route.compare } : {}),
    })
    a.toggleAttribute('aria-current', v === route.view)
  }
  // The compare view picks its own dates.
  windows.hidden = route.view === 'compare'
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
      compare: route.compare,
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

let stopLoading: (() => void) | undefined
window.addEventListener('hashchange', () => {
  route = parseRoute(location.hash)
  const done = render()
  // The minute refresh stays quiet; only a click shows its load.
  stopLoading?.()
  stopLoading = clicked ? showLoading(clicked, done) : undefined
  clicked = undefined
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
