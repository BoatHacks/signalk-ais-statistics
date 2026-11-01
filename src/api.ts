// REST routes (SPEC 6.1, ARCHITECTURE 2.9). Thin: validate parameters, call
// the query layer, serialize. Answers are cached for a minute and identical
// requests share one computation, so reloads and several open browsers do
// not repeat the history reads behind them. Every route is read-only and registered
// through router.access('readonly') where the server has it, so read-only
// users can open the web app; older servers keep them admin-only.
import { M_PER_NM } from './geo'
import type { Request, RequestHandler, Response } from 'express'
import { DAY_MS } from './aggregate'
import { footprintGeoJson, type Coverage } from './coverage'
import {
  MAX_SERIES_POINTS,
  METRICS,
  WINDOWS,
  isWindow,
  type Metric,
  type Query,
  type WindowName,
} from './query'
import type { LongRangeLog } from './longrange'
import { OVERLAY_DAYS } from './overlay'
import { SECTOR_CLASSES, type SectorClass } from './paths'

export interface Status {
  [key: string]: unknown
}

export interface ApiDeps {
  /** Undefined while the plugin is stopped. */
  query: () => Query | undefined
  coverage: () => Coverage | undefined
  longRange?: () => LongRangeLog | undefined
  status: () => Status
  /** Radar polygons and other extra features for the plotter overlay. */
  overlayExtras?: () => Promise<object[]>
  now?: () => number
  /** How long an answer is reused; 0 disables the cache. */
  cacheMs?: number
}

export const CACHE_MS = 60_000
/** Entries the long-range route returns, farthest first. */
export const LONG_RANGE_LIMIT = 25

interface Getter {
  get(path: string, ...handlers: RequestHandler[]): unknown
}

export interface RouterLike extends Getter {
  access?: (level: 'readonly') => Getter
}

class BadRequest extends Error {}
class NotRunning extends Error {}

const COVERAGE_DAYS: Partial<Record<WindowName, number>> = {
  '24h': 1,
  '7d': 7,
}

function param(req: Request, name: string): string | undefined {
  const v = req.query[name]
  return typeof v === 'string' ? v : undefined
}

function windowParam(req: Request, fallback: WindowName): WindowName {
  const w = param(req, 'window') ?? fallback
  if (!isWindow(w))
    throw new BadRequest(
      `window must be one of ${Object.keys(WINDOWS).join(', ')}`,
    )
  return w
}

function timeParam(req: Request, name: string, fallback: number): number {
  const v = param(req, name)
  if (v === undefined) return fallback
  const t = Date.parse(v)
  if (!Number.isFinite(t)) throw new BadRequest(`${name} must be an ISO time`)
  return t
}

type Cached = (
  req: Request,
  compute: () => Promise<unknown> | unknown,
) => Promise<unknown> | unknown

/**
 * Reuses answers for `ms` and shares in-flight ones, keyed by the query
 * parameters; failures are dropped.
 */
function answerCache(now: () => number, ms: number): Cached {
  const entries = new Map<string, { at: number; value: Promise<unknown> }>()
  return (req, compute) => {
    if (ms <= 0) return compute()
    const t = now()
    for (const [k, e] of entries) if (t - e.at >= ms) entries.delete(k)
    const key = Object.entries(req.query)
      .map(([k, v]) => `${k}=${String(v)}`)
      .sort()
      .join('&')
    const hit = entries.get(key)
    if (hit) return hit.value
    const value = Promise.resolve().then(compute)
    entries.set(key, { at: t, value })
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key)
    })
    return value
  }
}

function handle(
  fn: (req: Request) => Promise<unknown> | unknown,
  cached?: Cached,
): RequestHandler {
  return (req: Request, res: Response) => {
    Promise.resolve()
      .then(() => (cached ? cached(req, () => fn(req)) : fn(req)))
      .then((body) => {
        res.setHeader('Cache-Control', 'no-store')
        res.json(body)
      })
      .catch((err: unknown) => {
        if (err instanceof BadRequest)
          res.status(400).json({ error: err.message })
        else if (err instanceof NotRunning)
          res.status(503).json({ error: 'the plugin is not running' })
        else
          res.status(500).json({
            error: err instanceof Error ? err.message : 'internal error',
          })
      })
  }
}

export function registerRoutes(router: RouterLike, deps: ApiDeps): void {
  const r: Getter = router.access ? router.access('readonly') : router
  const now = deps.now ?? Date.now
  // One cache per route. A stopped plugin answers 503 even while an older
  // answer is cached.
  const cachedRoute = (): Cached => {
    const cache = answerCache(now, deps.cacheMs ?? CACHE_MS)
    return (req, compute) => {
      if (!deps.query()) throw new NotRunning()
      return cache(req, compute)
    }
  }
  const query = (): Query => {
    const q = deps.query()
    if (!q) throw new NotRunning()
    return q
  }
  const coverage = (): Coverage => {
    const c = deps.coverage()
    if (!c) throw new NotRunning()
    return c
  }

  r.get(
    '/summary',
    handle(
      (req) => query().summary(windowParam(req, '24h'), now()),
      cachedRoute(),
    ),
  )

  r.get(
    '/radar',
    handle((req) => {
      const cls = param(req, 'class') ?? 'all'
      if (cls !== 'all' && !SECTOR_CLASSES.includes(cls as SectorClass))
        throw new BadRequest('class must be a, b or all')
      return query().radar(
        windowParam(req, '24h'),
        cls as SectorClass | 'all',
        now(),
      )
    }, cachedRoute()),
  )

  r.get(
    '/series',
    handle((req) => {
      const metric = param(req, 'metric')
      if (!METRICS.includes(metric as Metric))
        throw new BadRequest(`metric must be one of ${METRICS.join(', ')}`)
      const resolution = Number(param(req, 'resolution') ?? 3600)
      if (!Number.isInteger(resolution) || resolution < 60)
        throw new BadRequest('resolution must be whole seconds, at least 60')
      const to = timeParam(req, 'to', now())
      const from = timeParam(req, 'from', to - DAY_MS)
      if (from >= to) throw new BadRequest('from must be before to')
      if ((to - from) / (resolution * 1000) > MAX_SERIES_POINTS)
        throw new BadRequest(
          `at most ${MAX_SERIES_POINTS} points; raise the resolution`,
        )
      return query().series(metric as Metric, resolution, from, to)
    }, cachedRoute()),
  )

  r.get(
    '/coverage',
    handle(async (req) => {
      const window = windowParam(req, '24h')
      const days = COVERAGE_DAYS[window]
      if (!days) throw new BadRequest('coverage windows are 24h and 7d')
      const all = param(req, 'all')
      if (all !== undefined && all !== 'true' && all !== 'false')
        throw new BadRequest('all must be true or false')
      const f = await coverage().footprint(days, now())
      return {
        window,
        days: f.days,
        resolution: f.resolution,
        cells: f.cells.length,
        cappedCells: f.cappedCells,
        capM: f.capNm === null ? null : Math.round(f.capNm * M_PER_NM),
        areaM2: Math.round(f.areaKm2 * 1e6),
        cellIds: f.cells.map((c) => c.id),
        geojson: footprintGeoJson(f, all === 'true'),
      }
    }, cachedRoute()),
  )

  r.get(
    '/longrange',
    handle(async (req) => {
      const window = windowParam(req, '24h')
      if (window === '1h') throw new BadRequest('windows are 24h and 7d')
      const log = deps.longRange?.()
      if (!log) throw new NotRunning()
      const to = now()
      const from = to - WINDOWS[window].ms
      return {
        window,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        entries: await log.entries(from, to + 1, LONG_RANGE_LIMIT),
      }
    }, cachedRoute()),
  )

  r.get(
    '/overlay/coverage.geojson',
    handle(async () => {
      const f = await coverage().footprint(OVERLAY_DAYS, now())
      const g = footprintGeoJson(f)
      const extras = deps.overlayExtras ? await deps.overlayExtras() : []
      return { ...g, features: [...g.features, ...extras] }
    }, cachedRoute()),
  )

  r.get(
    '/status',
    handle(() => deps.status()),
  )
}
