// REST routes (SPEC 6.1, ARCHITECTURE 2.9). Thin: validate parameters, call
// the query layer, serialize. Answers are cached for a minute and identical
// requests share one computation, so reloads and several open browsers do
// not repeat the history reads behind them. The read routes are registered
// through router.access('readonly') where the server has it, so read-only
// users can open the web app; older servers keep them admin-only. The one
// write route, POST /settings, saves live settings and is registered through
// router.access('readwrite'), or admin-only on older servers.
import { M_PER_NM } from './geo'
import type { Request, RequestHandler, Response } from 'express'
import { DAY_MS, HOUR_MS } from './aggregate'
import {
  COVERAGE_MODES,
  footprintGeoJson,
  utcDay,
  type Coverage,
  type CoverageMode,
} from './coverage'
import {
  EXPORT_WINDOWS,
  coverageCsv,
  exportFileName,
  isExportWindow,
  longRangeCsv,
  longRangeGeoJson,
  type ExportWindow,
} from './export'
import {
  MAX_RANGE_MS,
  MAX_SERIES_POINTS,
  METRICS,
  WINDOWS,
  isWindow,
  type Metric,
  type Query,
  type TimeRange,
  type WindowName,
} from './query'
import type { LongRangeLog } from './longrange'
import { OVERLAY_DAYS } from './overlay'
import { SECTOR_CLASSES, type SectorClass } from './paths'
import {
  InvalidSettings,
  liveBounds,
  parseLiveSettings,
  type LiveSettings,
} from './config'

export interface Status {
  [key: string]: unknown
}

export interface ApiDeps {
  /** Undefined while the plugin is stopped. */
  query: () => Query | undefined
  /** The query of one source label, when per-source statistics are on. */
  sourceQuery?: (label: string) => Query | undefined
  /** The sources counted, empty while per-source statistics are off. */
  sources?: () => { label: string; event: string }[] | undefined
  coverage: () => Coverage | undefined
  longRange?: () => LongRangeLog | undefined
  status: () => Status
  /** Sector polygons and other extra features for the plotter overlay. */
  overlayExtras?: () => Promise<object[]>
  /**
   * Saves validated live settings to the plugin config and applies them;
   * answers the effective live settings. Undefined while stopped.
   */
  saveSettings?: (values: Partial<LiveSettings>) => Promise<LiveSettings>
  /**
   * Days the coverage and long-range files are kept, the reach of an `all`
   * export. Undefined while stopped.
   */
  retentionDays?: () => number | undefined
  now?: () => number
  /** How long an answer is reused; 0 disables the cache. */
  cacheMs?: number
}

export const CACHE_MS = 60_000
/** Entries the long-range route returns, farthest first. */
export const LONG_RANGE_LIMIT = 25
/** Senders the long-range route returns in each fastest list. */
export const FASTEST_LIMIT = 10
/** The longest weather range, as for every other window (SPEC 12). */
export const WEATHER_MAX_MS = 7 * DAY_MS

interface Getter {
  get(path: string, ...handlers: RequestHandler[]): unknown
}

interface Poster {
  post(path: string, ...handlers: RequestHandler[]): unknown
}

export interface RouterLike extends Getter, Poster {
  access?: (level: 'readonly' | 'readwrite') => Getter & Poster
}

class BadRequest extends Error {}
class NotRunning extends Error {}
class NotJson extends Error {}

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

/**
 * A `from`/`to` range in whole hours (ISO times), as the compare view asks
 * for it, or undefined when the request names neither. At most 7 days, and
 * it must start before now.
 */
function rangeParam(req: Request, now: number): TimeRange | undefined {
  const f = param(req, 'from')
  const t = param(req, 'to')
  if (f === undefined && t === undefined) return undefined
  if (f === undefined || t === undefined)
    throw new BadRequest('from and to go together')
  if (param(req, 'window') !== undefined)
    throw new BadRequest('give either window or from and to')
  const from = Date.parse(f)
  const to = Date.parse(t)
  if (!Number.isFinite(from) || !Number.isFinite(to))
    throw new BadRequest('from and to must be ISO times')
  if (from % HOUR_MS !== 0 || to % HOUR_MS !== 0)
    throw new BadRequest('from and to must be whole hours')
  if (from >= to) throw new BadRequest('from must be before to')
  if (to - from > MAX_RANGE_MS)
    throw new BadRequest('the range is at most 7 days')
  if (from >= now) throw new BadRequest('from must be in the past')
  return { from, to }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** A `from`/`to` range of UTC days, both included, at most 7 days. */
function dayRangeParam(req: Request): { from: string; to: string } | undefined {
  const from = param(req, 'from')
  const to = param(req, 'to')
  if (from === undefined && to === undefined) return undefined
  if (from === undefined || to === undefined)
    throw new BadRequest('from and to go together')
  if (param(req, 'window') !== undefined)
    throw new BadRequest('give either window or from and to')
  const valid = (d: string) => {
    const t = Date.parse(d)
    return DAY_RE.test(d) && Number.isFinite(t) && utcDay(t) === d
  }
  if (!valid(from) || !valid(to))
    throw new BadRequest('from and to must be UTC days, YYYY-MM-DD')
  if (from > to) throw new BadRequest('from must not be after to')
  if (Date.parse(to) - Date.parse(from) >= MAX_RANGE_MS)
    throw new BadRequest('the range is at most 7 days')
  return { from, to }
}

/** A trial coverage cap percentile, within the setting's bounds. */
function capParam(req: Request): number | undefined {
  const v = param(req, 'cap')
  if (v === undefined) return undefined
  const { min, max } = liveBounds('coverageDistancePercentile')
  const n = Number(v)
  if (v.trim() === '' || !Number.isFinite(n) || n < min || n > max)
    throw new BadRequest(`cap must be a number from ${min} to ${max}`)
  return n
}

/** The own vessel mode whose coverage cells to answer with; all by default. */
function modeParam(req: Request): CoverageMode {
  const v = param(req, 'mode') ?? 'all'
  if (!(COVERAGE_MODES as readonly string[]).includes(v))
    throw new BadRequest(`mode must be one of ${COVERAGE_MODES.join(', ')}`)
  return v as CoverageMode
}

function flagParam(req: Request, name: string): boolean {
  const v = param(req, name)
  if (v === undefined || v === 'false') return false
  if (v === 'true') return true
  throw new BadRequest(`${name} must be true or false`)
}

function exportWindowParam(req: Request): ExportWindow {
  const w = param(req, 'window') ?? '24h'
  if (!isExportWindow(w))
    throw new BadRequest(`window must be one of ${EXPORT_WINDOWS.join(', ')}`)
  return w
}

function timeParam(req: Request, name: string, fallback: number): number {
  const v = param(req, name)
  if (v === undefined) return fallback
  const t = Date.parse(v)
  if (!Number.isFinite(t)) throw new BadRequest(`${name} must be an ISO time`)
  return t
}

type Cached = ((
  req: Request,
  compute: () => Promise<unknown> | unknown,
) => Promise<unknown> | unknown) & { clear: () => void }

/**
 * Reuses answers for `ms` and shares in-flight ones, keyed by the query
 * parameters; failures are dropped.
 */
function answerCache(now: () => number, ms: number): Cached {
  const entries = new Map<string, { at: number; value: Promise<unknown> }>()
  const cached = (req: Request, compute: () => Promise<unknown> | unknown) => {
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
  return Object.assign(cached, { clear: () => entries.clear() })
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof BadRequest || err instanceof InvalidSettings)
    res.status(400).json({ error: err.message })
  else if (err instanceof NotJson)
    res.status(415).json({ error: 'send application/json' })
  else if (err instanceof NotRunning)
    res.status(503).json({ error: 'the plugin is not running' })
  else
    res.status(500).json({
      error: err instanceof Error ? err.message : 'internal error',
    })
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
      .catch((err: unknown) => sendError(res, err))
  }
}

/** A file download: the body as text, with its type and file name. */
interface FileBody {
  body: string
  type: string
  filename: string
}

/** Like `handle`, but sends a file as an attachment; errors stay JSON. */
function handleFile(
  fn: (req: Request) => Promise<FileBody> | FileBody,
  cached?: Cached,
): RequestHandler {
  return (req: Request, res: Response) => {
    Promise.resolve()
      .then(() => (cached ? cached(req, () => fn(req)) : fn(req)))
      .then((f) => {
        const { body, type, filename } = f as FileBody
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Type', type)
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename}"`,
        )
        res.send(body)
      })
      .catch((err: unknown) => sendError(res, err))
  }
}

export function registerRoutes(router: RouterLike, deps: ApiDeps): void {
  const r: Getter = router.access ? router.access('readonly') : router
  const w: Poster = router.access ? router.access('readwrite') : router
  const now = deps.now ?? Date.now
  // One cache per route. A stopped plugin answers 503 even while an older
  // answer is cached. A saved setting clears them all.
  const caches: Cached[] = []
  const cachedRoute = (): Cached => {
    const cache = answerCache(now, deps.cacheMs ?? CACHE_MS)
    caches.push(cache)
    const guarded = (
      req: Request,
      compute: () => Promise<unknown> | unknown,
    ) => {
      if (!deps.query()) throw new NotRunning()
      return cache(req, compute)
    }
    return Object.assign(guarded, { clear: cache.clear })
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
    handle((req) => {
      const t = now()
      const source = param(req, 'source')
      let q = query()
      if (source !== undefined && source !== 'all') {
        const sq = deps.sourceQuery?.(source)
        if (!sq)
          throw new BadRequest(
            'source must be all or a label from /sources (per-source statistics must be on)',
          )
        q = sq
      }
      return q.summary(rangeParam(req, t) ?? windowParam(req, '24h'), t)
    }, cachedRoute()),
  )

  r.get(
    '/sources',
    handle(() => {
      if (!deps.query()) throw new NotRunning()
      return { sources: deps.sources?.() ?? [] }
    }),
  )

  r.get(
    '/sectors',
    handle((req) => {
      const cls = param(req, 'class') ?? 'all'
      if (cls !== 'all' && !SECTOR_CLASSES.includes(cls as SectorClass))
        throw new BadRequest('class must be a, b or all')
      const t = now()
      return query().sectors(
        rangeParam(req, t) ?? windowParam(req, '24h'),
        cls as SectorClass | 'all',
        t,
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
    '/weather',
    handle((req) => {
      const to = timeParam(req, 'to', now())
      const from = timeParam(req, 'from', to - DAY_MS)
      if (from >= to) throw new BadRequest('from must be before to')
      if (to - from > WEATHER_MAX_MS)
        throw new BadRequest('the range is at most 7 days')
      return query().weather(from, to)
    }, cachedRoute()),
  )

  r.get(
    '/coverage',
    handle(async (req) => {
      const range = dayRangeParam(req)
      const window = range ? null : windowParam(req, '24h')
      const days = window ? COVERAGE_DAYS[window] : undefined
      if (window && !days)
        throw new BadRequest('coverage windows are 24h and 7d')
      const all = param(req, 'all')
      if (all !== undefined && all !== 'true' && all !== 'false')
        throw new BadRequest('all must be true or false')
      const mode = modeParam(req)
      const cov = coverage()
      const percentile = capParam(req) ?? cov.capPercentile()
      const t = now()
      const f = range
        ? await cov.footprintRange(range.from, range.to, t, percentile, mode)
        : await cov.footprint(days!, t, percentile, mode)
      return {
        window,
        mode,
        ...(range ? { from: range.from, to: range.to } : {}),
        retainedFrom: cov.retainedFrom(t),
        days: f.days,
        resolution: f.resolution,
        capPercentile: percentile,
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
        fastest: await log.fastest(from, to + 1, FASTEST_LIMIT),
        implausibleJumps: await log.fastest(from, to + 1, FASTEST_LIMIT, true),
      }
    }, cachedRoute()),
  )

  // Downloads (SPEC 6.1). `all` reaches back as far as the files are kept.
  const exportDays = (window: ExportWindow): number => {
    if (window === '24h') return 1
    if (window === '7d') return 7
    const days = deps.retentionDays?.()
    if (days === undefined) throw new NotRunning()
    return days
  }
  const longRangeEntries = (window: ExportWindow) => {
    const log = deps.longRange?.()
    if (!log) throw new NotRunning()
    const to = now()
    // 24h and 7d are rolling, as on /longrange; all starts at the oldest
    // retained UTC day.
    const from =
      window === 'all'
        ? Date.parse(utcDay(to - (exportDays(window) - 1) * DAY_MS))
        : to - WINDOWS[window].ms
    // Every entry: the day files already bound how many there are.
    return log.entries(from, to + 1, Infinity)
  }

  r.get(
    '/export/coverage.csv',
    handleFile(async (req) => {
      const window = exportWindowParam(req)
      const all = flagParam(req, 'all')
      const mode = modeParam(req)
      const t = now()
      const cov = coverage()
      const f = await cov.footprint(
        exportDays(window),
        t,
        cov.capPercentile(),
        mode,
      )
      return {
        body: coverageCsv(f, all),
        type: 'text/csv; charset=utf-8',
        filename: exportFileName(
          all ? 'coverage-allcells' : 'coverage',
          window,
          t,
          'csv',
          false,
          mode,
        ),
      }
    }, cachedRoute()),
  )

  r.get(
    '/export/longrange.csv',
    handleFile(async (req) => {
      const window = exportWindowParam(req)
      const anonymise = flagParam(req, 'anonymise')
      return {
        body: longRangeCsv(await longRangeEntries(window), anonymise),
        type: 'text/csv; charset=utf-8',
        filename: exportFileName('longrange', window, now(), 'csv', anonymise),
      }
    }, cachedRoute()),
  )

  r.get(
    '/export/longrange.geojson',
    handleFile(async (req) => {
      const window = exportWindowParam(req)
      if (flagParam(req, 'anonymise'))
        throw new BadRequest(
          'an anonymised export has no positions; use longrange.csv',
        )
      return {
        body: JSON.stringify(longRangeGeoJson(await longRangeEntries(window))),
        type: 'application/geo+json',
        filename: exportFileName('longrange', window, now(), 'geojson'),
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

  w.post(
    '/settings',
    handle(async (req) => {
      // Only JSON, so a plain HTML form on another site cannot post here.
      const type = String(req.headers?.['content-type'] ?? '')
      if (!/^application\/json\b/i.test(type)) throw new NotJson()
      const values = parseLiveSettings(req.body)
      const save = deps.query() ? deps.saveSettings : undefined
      if (!save) throw new NotRunning()
      const saved = await save(values)
      for (const c of caches) c.clear()
      return { settings: saved }
    }),
  )
}
