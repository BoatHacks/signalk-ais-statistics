// Hash routes: #/overview, #/charts, #/sectors and #/map, with the window as
// a query part, for example #/charts?window=7d. #/radar, the sectors view's
// earlier name, still opens it.
export const VIEWS = ['overview', 'charts', 'sectors', 'map'] as const
export type View = (typeof VIEWS)[number]
export const WINDOWS = ['1h', '24h', '7d'] as const
export type WindowName = (typeof WINDOWS)[number]

export interface Route {
  view: View
  window: WindowName
}

export function parseRoute(hash: string): Route {
  const [raw = '', query = ''] = hash.replace(/^#\/?/, '').split('?')
  const path = raw === 'radar' ? 'sectors' : raw
  const view = (VIEWS as readonly string[]).includes(path)
    ? (path as View)
    : 'overview'
  const w = new URLSearchParams(query).get('window') ?? ''
  let window: WindowName = (WINDOWS as readonly string[]).includes(w)
    ? (w as WindowName)
    : '24h'
  // The map has no one hour window: coverage is kept per day.
  if (view === 'map' && window === '1h') window = '24h'
  return { view, window }
}

export function formatRoute(r: Route): string {
  return `#/${r.view}?window=${r.window}`
}
