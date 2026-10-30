// AIS Statistics web app (SPEC 7): overview, charts, radar and map. Talks
// only to the plugin's REST API; all assets are bundled.
import {
  HttpError,
  get,
  type Radar,
  type Series,
  type Status,
  type Summary,
  type WindowName,
} from './api'
import { lineChart, stackedBars } from './charts'
import { el, int, nm } from './format'
import { createMap } from './map'
import { radarChart } from './radar'

const COLORS = {
  a: 'var(--series-1)',
  b: 'var(--series-2)',
  other: 'var(--series-3)',
  d4: 'var(--series-4)',
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
const VIEWS = ['overview', 'charts', 'radar', 'map'] as const
type View = (typeof VIEWS)[number]

const app = document.getElementById('app')!
let view: View = 'overview'
let win: WindowName = '24h'
const mapView = createMap()

const header = el('header', {}, el('h1', {}, 'AIS Statistics'))
const statusLine = el('p', { class: 'status muted' })
const nav = el('nav', { class: 'tabs', role: 'tablist' })
const windows = el('div', {
  class: 'segmented',
  role: 'group',
  'aria-label': 'Window',
})
const main = el('main')
app.append(header, statusLine, nav, windows, main)

for (const v of VIEWS) {
  const b = el(
    'button',
    { type: 'button', role: 'tab', 'data-view': v },
    v[0]!.toUpperCase() + v.slice(1),
  )
  b.addEventListener('click', () => {
    view = v
    if (v === 'map' && win === '1h') win = '24h'
    void render()
  })
  nav.append(b)
}

function renderWindows() {
  windows.replaceChildren()
  const options: WindowName[] =
    view === 'map' ? ['24h', '7d', '30d'] : ['1h', '24h', '7d', '30d']
  for (const w of options) {
    const b = el(
      'button',
      { type: 'button', 'aria-pressed': String(w === win) },
      view === 'map' && w === '24h' ? 'Today' : w,
    )
    b.addEventListener('click', () => {
      win = w
      void render()
    })
    windows.append(b)
  }
  for (const b of nav.querySelectorAll('button'))
    b.setAttribute('aria-selected', String(b.dataset.view === view))
}

function tile(label: string, value: string, note?: string): HTMLElement {
  return el(
    'div',
    { class: 'tile' },
    el('span', { class: 'label' }, label),
    el('span', { class: 'value' }, value),
    ...(note ? [el('span', { class: 'note' }, note)] : []),
  )
}

function sourceNote(source: 'history' | 'live'): HTMLElement {
  return el(
    'p',
    { class: 'muted small' },
    source === 'history'
      ? 'From the server history.'
      : 'From live data held by the plugin (no history provider, or the last hour).',
  )
}

async function overview(): Promise<HTMLElement> {
  const s = await get<Summary>('/summary', { window: win })
  const d = s.distance
  const out = el('section')
  out.append(
    el(
      'div',
      { class: 'tiles' },
      tile('Messages', int(s.messages)),
      tile('Positions class A', int(s.positions.classA)),
      tile('Positions class B', int(s.positions.classB)),
      tile(
        'Vessels',
        s.vessels ? int(s.vessels.total) : 'see charts',
        s.vessels ? undefined : 'unique counts do not add up over days',
      ),
    ),
    el('h2', {}, 'Distance'),
    el(
      'div',
      { class: 'tiles' },
      tile('p99', nm(d.p99Nm), 'typical best case'),
      tile('p95', nm(d.p95Nm)),
      tile('Median', nm(d.medianNm)),
      tile('Average', nm(d.avgNm)),
      tile('Maximum', nm(d.maxNm), 'untrusted: one bad position sets it'),
    ),
  )
  if (s.vessels) {
    const rows = Object.entries(s.vessels.byGroup).filter(([, n]) => n > 0)
    out.append(el('h2', {}, 'Vessels by type'))
    if (rows.length === 0)
      out.append(el('p', { class: 'muted' }, 'No vessels in this window.'))
    else
      out.append(
        el(
          'table',
          { class: 'groups' },
          ...rows
            .sort((a, b) => b[1] - a[1])
            .map(([g, n]) =>
              el(
                'tr',
                {},
                el('th', {}, GROUP_LABELS[g] ?? g),
                el('td', {}, int(n)),
              ),
            ),
        ),
      )
  }
  out.append(sourceNote(s.source))
  return out
}

const RESOLUTION: Record<WindowName, number> = {
  '1h': 60,
  '24h': 3600,
  '7d': 3600,
  '30d': 86400,
}
const SPAN: Record<WindowName, number> = {
  '1h': 3600e3,
  '24h': 86400e3,
  '7d': 7 * 86400e3,
  '30d': 30 * 86400e3,
}

async function charts(): Promise<HTMLElement> {
  const to = new Date()
  const params = {
    resolution: String(RESOLUTION[win]),
    from: new Date(to.getTime() - SPAN[win]).toISOString(),
    to: to.toISOString(),
  }
  const [pos, msg, dist, ves] = await Promise.all([
    get<Series>('/series', { ...params, metric: 'positions' }),
    get<Series>('/series', { ...params, metric: 'messages' }),
    get<Series>('/series', { ...params, metric: 'distance' }),
    get<Series>('/series', { ...params, metric: 'vessels' }),
  ])
  const col = (s: Series, k: string) => (s[k] as (number | null)[]) ?? []
  const n = (v: number | null) =>
    v === null ? 'no data' : Math.round(v).toLocaleString()
  const d = (v: number | null) =>
    v === null ? 'no data' : v >= 10 ? `${Math.round(v)} nm` : nm(v)
  const per =
    pos.resolution >= 86400 ? 'day' : pos.resolution >= 3600 ? 'hour' : 'minute'
  return el(
    'section',
    {},
    el('h2', {}, `Positions per ${per}`),
    stackedBars(
      pos.times,
      [
        { name: 'Class A', color: COLORS.a, values: col(pos, 'classA') },
        { name: 'Class B', color: COLORS.b, values: col(pos, 'classB') },
        { name: 'Other', color: COLORS.other, values: col(pos, 'other') },
      ],
      n,
    ),
    el('h2', {}, `Messages per ${per}`),
    lineChart(
      msg.times,
      [{ name: 'Messages', color: COLORS.a, values: col(msg, 'messages') }],
      n,
    ),
    el('h2', {}, `Distance per ${per}`),
    lineChart(
      dist.times,
      [
        { name: 'p99', color: COLORS.a, values: col(dist, 'p99Nm') },
        { name: 'p95', color: COLORS.b, values: col(dist, 'p95Nm') },
        { name: 'Median', color: COLORS.other, values: col(dist, 'medianNm') },
        { name: 'Average', color: COLORS.d4, values: col(dist, 'avgNm') },
      ],
      d,
    ),
    el('h3', {}, 'Maximum distance (untrusted)'),
    lineChart(
      dist.times,
      [{ name: 'Maximum', color: COLORS.b, values: col(dist, 'maxNm') }],
      d,
    ),
    el(
      'h2',
      {},
      ves.resolution >= 86400
        ? 'Unique vessels per day'
        : 'Unique vessels in the past hour',
    ),
    lineChart(
      ves.times,
      [{ name: 'Vessels', color: COLORS.a, values: col(ves, 'vessels') }],
      n,
    ),
    sourceNote(pos.source),
  )
}

async function radar(): Promise<HTMLElement> {
  const [a, b] = await Promise.all([
    get<Radar>('/radar', { window: win, class: 'a' }),
    get<Radar>('/radar', { window: win, class: 'b' }),
  ])
  return el(
    'section',
    {},
    el(
      'p',
      { class: 'muted small' },
      'Radius per 15° sector: the highest hourly p99 distance in the window.',
    ),
    el(
      'div',
      { class: 'radars' },
      el('div', {}, el('h2', {}, 'Class A'), radarChart(a, COLORS.a)),
      el('div', {}, el('h2', {}, 'Class B'), radarChart(b, COLORS.b)),
    ),
    sourceNote(a.source),
  )
}

async function updateStatus() {
  try {
    const s = await get<Status>('/status')
    statusLine.textContent = !s.running
      ? 'The plugin is not running.'
      : s.noData
        ? 'No AIS data received since the plugin started.'
        : `${s.trackedTargets ?? 0} targets tracked. Own position ${s.ownPositionFresh ? 'known' : 'unknown or stale, so distances are not counted'}. History ${s.historyAvailable ? 'available' : 'not available, showing live data only'}.`
  } catch (err) {
    statusLine.textContent = describe(err)
  }
}

function describe(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403))
    return 'Please log in to the SignalK server to see the statistics.'
  if (err instanceof HttpError && err.status === 503)
    return 'The plugin is not running.'
  return `Could not load: ${err instanceof Error ? err.message : String(err)}`
}

let generation = 0
async function render() {
  const g = ++generation
  renderWindows()
  mapView.element.hidden = view !== 'map'
  try {
    if (view === 'map') {
      if (!main.contains(mapView.element)) main.replaceChildren(mapView.element)
      await mapView.show(win === '1h' ? '24h' : win)
      return
    }
    const content = await (view === 'overview'
      ? overview()
      : view === 'charts'
        ? charts()
        : radar())
    if (g === generation) main.replaceChildren(content)
  } catch (err) {
    if (g === generation)
      main.replaceChildren(el('p', { class: 'error' }, describe(err)))
  }
}

void updateStatus()
void render()
setInterval(() => {
  void updateStatus()
  if (view !== 'map') void render()
}, 60_000)
