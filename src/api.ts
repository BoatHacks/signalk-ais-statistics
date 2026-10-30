// REST routes (SPEC 6.1, ARCHITECTURE 2.9). Thin: validate parameters, call
// the query layer, serialize. Every route is read-only and registered
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
import { OVERLAY_DAYS } from './overlay'
import { SECTOR_CLASSES, type SectorClass } from './paths'

export interface Status {
  [key: string]: unknown
}

export interface ApiDeps {
  /** Undefined while the plugin is stopped. */
  query: () => Query | undefined
  coverage: () => Coverage | undefined
  status: () => Status
  /** Radar polygons and other extra features for the plotter overlay. */
  overlayExtras?: () => Promise<object[]>
  now?: () => number
}

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
  '30d': 30,
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

function handle(
  fn: (req: Request) => Promise<unknown> | unknown,
): RequestHandler {
  return (req: Request, res: Response) => {
    Promise.resolve()
      .then(() => fn(req))
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
    handle((req) => query().summary(windowParam(req, '24h'), now())),
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
    }),
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
    }),
  )

  r.get(
    '/coverage',
    handle(async (req) => {
      const window = windowParam(req, '24h')
      const days = COVERAGE_DAYS[window]
      if (!days) throw new BadRequest('coverage windows are 24h, 7d and 30d')
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
        geojson: footprintGeoJson(f),
      }
    }),
  )

  r.get(
    '/overlay/coverage.geojson',
    handle(async () => {
      const f = await coverage().footprint(OVERLAY_DAYS, now())
      const g = footprintGeoJson(f)
      const extras = deps.overlayExtras ? await deps.overlayExtras() : []
      return { ...g, features: [...g.features, ...extras] }
    }),
  )

  r.get(
    '/status',
    handle(() => deps.status()),
  )
}
