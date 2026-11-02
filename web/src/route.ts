// Hash routes: #/overview, #/charts, #/sectors, #/map and #/compare, with
// the window as a query part, for example #/charts?window=7d. The map also
// takes the own vessel mode, for example #/map?window=7d&mode=underway. The compare
// view takes the hour of the change in UTC and a length in hours instead,
// for example #/compare?at=2030-01-08T14:00Z&hours=24.
export const VIEWS = [
  'overview',
  'charts',
  'sectors',
  'map',
  'compare',
] as const
export type View = (typeof VIEWS)[number]
export const WINDOWS = ['1h', '24h', '7d'] as const
export type WindowName = (typeof WINDOWS)[number]
/** Coverage cells per own vessel mode on the map (SPEC 7). */
export const MAP_MODES = ['all', 'stationary', 'underway'] as const
export type MapMode = (typeof MAP_MODES)[number]

/**
 * Lengths of each compare window in hours. The longest fits twice into the
 * default coverage retention and stays below the 7 day range limit
 * (SPEC 12).
 */
export const COMPARE_HOURS = [1, 6, 12, 24, 48, 120] as const
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export interface CompareParams {
  /** The change: end of the before window and start of the after window,
   * a whole UTC hour in milliseconds. */
  at: number
  /** Length of each window in hours, one of COMPARE_HOURS. */
  hours: number
  /** `all`, or a source label when per-source statistics are on. */
  source: string
}

export interface Route {
  view: View
  window: WindowName
  /** Only for the map view, when not `all`. */
  mode?: MapMode
  /** Only for the compare view. */
  compare?: CompareParams
}

const hourStart = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS

/** `2030-01-08T14:00Z`, the form of `at` in the hash. */
export const formatAt = (t: number) =>
  `${new Date(t).toISOString().slice(0, 13)}:00Z`

function parseAt(v: string | null): number | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:00Z$/.test(v)) return undefined
  const t = Date.parse(v)
  // Rejects dates such as February 30, which Date.parse rolls over.
  return Number.isFinite(t) && formatAt(t) === v ? t : undefined
}

/**
 * The compare default: windows of the longest length, whole UTC days so
 * coverage is compared too, the after window ending with today. Both fit
 * in the default coverage retention.
 */
export function defaultCompare(now: number): CompareParams {
  const hours = 120
  return {
    at: Math.floor(now / DAY_MS) * DAY_MS - (hours / 24 - 1) * DAY_MS,
    hours,
    source: 'all',
  }
}

export function parseRoute(hash: string, now = Date.now()): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?')
  const view = (VIEWS as readonly string[]).includes(path)
    ? (path as View)
    : 'overview'
  const q = new URLSearchParams(query)
  const w = q.get('window') ?? ''
  let window: WindowName = (WINDOWS as readonly string[]).includes(w)
    ? (w as WindowName)
    : '24h'
  // The map has no one hour window: coverage is kept per day.
  if (view === 'map' && window === '1h') window = '24h'
  if (view === 'map') {
    const m = q.get('mode') ?? ''
    return (MAP_MODES as readonly string[]).includes(m) && m !== 'all'
      ? { view, window, mode: m as MapMode }
      : { view, window }
  }
  if (view !== 'compare') return { view, window }
  const fallback = defaultCompare(now)
  const at = parseAt(q.get('at'))
  const hours = Number(q.get('hours'))
  const source = q.get('source') ?? ''

  return {
    view,
    window,
    compare: {
      // A change after the current hour has nothing to compare.
      at: at !== undefined && at <= hourStart(now) ? at : fallback.at,
      hours: (COMPARE_HOURS as readonly number[]).includes(hours)
        ? hours
        : fallback.hours,
      // Labels are letters, digits and underscores (src/paths.ts).
      source: /^[A-Za-z0-9_]+$/.test(source) ? source : 'all',
    },
  }
}

export function formatRoute(r: Route): string {
  if (r.view === 'compare') {
    const c = r.compare ?? defaultCompare(Date.now())
    const source = c.source === 'all' ? '' : `&source=${c.source}`
    return `#/compare?at=${formatAt(c.at)}&hours=${c.hours}${source}`
  }
  const mode =
    r.view === 'map' && r.mode && r.mode !== 'all' ? `&mode=${r.mode}` : ''
  return `#/${r.view}?window=${r.window}${mode}`
}
