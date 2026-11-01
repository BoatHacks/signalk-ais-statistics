// Hash routes: #/overview, #/charts, #/sectors, #/map and #/compare, with
// the window as a query part, for example #/charts?window=7d. The compare
// view takes a date and a length in days instead, for example
// #/compare?date=2030-01-08&days=7.
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

/** The longest compare window, the longest window there is (SPEC 12). */
export const MAX_COMPARE_DAYS = 7
const DAY_MS = 86_400_000

export interface CompareParams {
  /** UTC day the after window starts on, YYYY-MM-DD. */
  date: string
  /** Length of each window in days. */
  days: number
}

export interface Route {
  view: View
  window: WindowName
  /** Only for the compare view. */
  compare?: CompareParams
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10)

function validDay(d: string | null): d is string {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const t = Date.parse(d)
  return Number.isFinite(t) && utcDay(t) === d
}

/**
 * The compare default: windows of the longest length, the after window
 * ending today, so both fit in the default coverage retention.
 */
export function defaultCompare(now: number): CompareParams {
  return {
    date: utcDay(now - (MAX_COMPARE_DAYS - 1) * DAY_MS),
    days: MAX_COMPARE_DAYS,
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
  if (view !== 'compare') return { view, window }
  const fallback = defaultCompare(now)
  const date = q.get('date')
  const days = Number(q.get('days'))
  // A date after today has nothing to compare.
  const today = utcDay(now)
  return {
    view,
    window,
    compare: {
      date: validDay(date) && date <= today ? date : fallback.date,
      days:
        Number.isInteger(days) && days >= 1 && days <= MAX_COMPARE_DAYS
          ? days
          : fallback.days,
    },
  }
}

export function formatRoute(r: Route): string {
  if (r.view === 'compare') {
    const c = r.compare ?? defaultCompare(Date.now())
    return `#/compare?date=${c.date}&days=${c.days}`
  }
  return `#/${r.view}?window=${r.window}`
}
