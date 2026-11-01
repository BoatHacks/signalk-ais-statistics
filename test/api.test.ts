import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Aggregator } from '../src/aggregate'
import { registerRoutes } from '../src/api'
import { Coverage } from '../src/coverage'
import { destination } from '../src/geo'
import { nullHistoryReader } from '../src/history'
import { LongRangeLog } from '../src/longrange'
import { Query } from '../src/query'
import { OWN } from './fixtures/ais'
import { fakeRouter } from './fixtures/router'

const T0 = Date.UTC(2030, 0, 1, 12)

async function setup(withAccess = true, running = true) {
  const agg = new Aggregator(T0)
  const coverage = new Coverage(
    await mkdtemp(join(tmpdir(), 'ais-api-')),
    5,
    90,
    99,
    T0,
  )
  const longRange = new LongRangeLog(
    await mkdtemp(join(tmpdir(), 'ais-api-')),
    14,
    T0,
  )
  for (let i = 0; i < 20; i++) {
    const p = destination(OWN, 100, 10 + i)
    const located = agg.add({ type: 1, mmsi: `99900000${i}`, ...p }, OWN, T0)
    if (located) {
      coverage.add(located.lat, located.lon, located.distanceNm, T0)
      longRange.add(located, {})
    }
  }
  // One far, bogus-looking report that the coverage cap leaves out.
  const far = destination(OWN, 200, 900)
  coverage.add(far.lat, far.lon, 900, T0)
  const f = fakeRouter(withAccess)
  const saved: object[] = []
  registerRoutes(f.router, {
    query: () =>
      running ? new Query(agg, () => nullHistoryReader) : undefined,
    coverage: () => coverage,
    longRange: () => longRange,
    status: () => ({ history: false }),
    saveSettings: async (values) => {
      saved.push(values)
      const live = { coverageDistancePercentile: 99, ...values }
      coverage.setPercentile(live.coverageDistancePercentile)
      return live
    },
    now: () => T0 + 1000,
  })
  return { ...f, saved }
}

describe('REST API answer cache', () => {
  async function counted(cacheMs?: number) {
    const agg = new Aggregator(T0)
    const q = new Query(agg, () => nullHistoryReader)
    let calls = 0
    const summary = q.summary.bind(q)
    q.summary = async (...args) => {
      calls++
      return summary(...args)
    }
    let t = T0
    let running = true
    const f = fakeRouter()
    registerRoutes(f.router, {
      query: () => (running ? q : undefined),
      coverage: () => undefined,
      status: () => ({}),
      now: () => t,
      cacheMs,
    })
    return {
      ...f,
      calls: () => calls,
      advance: (ms: number) => (t += ms),
      stop: () => (running = false),
    }
  }

  it('reuses an answer for a minute, per set of parameters', async () => {
    const c = await counted()
    await c.call('/summary', { window: '24h' })
    await c.call('/summary', { window: '24h' })
    expect(c.calls()).toBe(1)
    await c.call('/summary', { window: '7d' })
    expect(c.calls()).toBe(2)
    c.advance(60_000)
    await c.call('/summary', { window: '24h' })
    expect(c.calls()).toBe(3)
  })

  it('shares one computation between simultaneous requests', async () => {
    const c = await counted()
    await Promise.all([
      c.call('/summary', { window: '24h' }),
      c.call('/summary', { window: '24h' }),
    ])
    expect(c.calls()).toBe(1)
  })

  it('answers 503 once stopped, cached or not', async () => {
    const c = await counted()
    await c.call('/summary', { window: '24h' })
    c.stop()
    expect((await c.call('/summary', { window: '24h' })).status).toBe(503)
  })

  it('can be switched off', async () => {
    const c = await counted(0)
    await c.call('/summary', { window: '24h' })
    await c.call('/summary', { window: '24h' })
    expect(c.calls()).toBe(2)
  })
})

describe('REST API', () => {
  it('registers the read routes read-only and the save route readwrite', async () => {
    const { routes } = await setup()
    expect([...routes.keys()].sort()).toEqual([
      '/coverage',
      '/longrange',
      '/overlay/coverage.geojson',
      '/sectors',
      '/series',
      '/status',
      '/summary',
      'POST /settings',
    ])
    for (const [key, r] of routes)
      expect(r.access, key).toBe(
        key === 'POST /settings' ? 'readwrite' : 'readonly',
      )
  })

  it('includes the cells beyond the cap when asked', async () => {
    const { call } = await setup()
    type Cov = {
      cappedCells: number
      geojson: { features: { properties: { capped?: boolean } }[] }
    }
    const capped = (await call('/coverage', { window: '24h' })).body as Cov
    expect(capped.cappedCells).toBeGreaterThan(0)
    expect(capped.geojson.features.some((f) => f.properties.capped)).toBe(false)
    const all = (await call('/coverage', { window: '24h', all: 'true' }))
      .body as Cov
    expect(
      all.geojson.features.filter((f) => f.properties.capped),
    ).toHaveLength(capped.cappedCells)
    expect((await call('/coverage', { all: 'yes' })).status).toBe(400)
  })

  it('serves the farthest receptions of a window', async () => {
    const { call } = await setup()
    const r = await call('/longrange', { window: '24h' })
    const entries = (r.body as { entries: { mmsi: string }[] }).entries
    expect(entries[0]!.mmsi).toBe('9990000019')
    expect(entries).toHaveLength(20)
    expect((await call('/longrange', { window: '1h' })).status).toBe(400)
  })

  it('falls back to admin-only routes on servers without access()', async () => {
    const { routes } = await setup(false)
    expect(routes.has('POST /settings')).toBe(true)
    for (const r of routes.values()) expect(r.access).toBe('admin')
  })

  it('tries a coverage cap without saving it', async () => {
    const { call, saved } = await setup()
    type Cov = { cappedCells: number; capM: number | null }
    const base = (await call('/coverage')).body as Cov
    expect(base.cappedCells).toBe(1)
    const open = (await call('/coverage', { cap: '100' })).body as Cov
    expect(open.cappedCells).toBe(0)
    expect(open.capM).toBeNull()
    // The configured cap is unchanged, cached or not.
    expect(((await call('/coverage')).body as Cov).cappedCells).toBe(1)
    expect(saved).toEqual([])
    for (const cap of ['49', '101', 'x', '', '1e400'])
      expect((await call('/coverage', { cap })).status, cap).toBe(400)
  })
})

describe('POST /settings', () => {
  it('saves live settings and clears the cached answers', async () => {
    const { call, post, saved } = await setup()
    type Cov = { cappedCells: number }
    expect(((await call('/coverage')).body as Cov).cappedCells).toBe(1)
    const r = await post('/settings', { coverageDistancePercentile: 100 })
    expect(r).toEqual({
      status: 200,
      body: { settings: { coverageDistancePercentile: 100 } },
    })
    expect(saved).toEqual([{ coverageDistancePercentile: 100 }])
    expect(((await call('/coverage')).body as Cov).cappedCells).toBe(0)
  })

  it('rejects other keys, wrong types and values out of bounds', async () => {
    const { post, saved } = await setup()
    for (const body of [
      { publishIntervalMinutes: 1 },
      { coverageDistancePercentile: 95, h3Resolution: 8 },
      { coverageDistancePercentile: '95' },
      { coverageDistancePercentile: 49 },
      { coverageDistancePercentile: 101 },
      {},
      [],
      null,
      'coverageDistancePercentile=95',
    ]) {
      const r = await post('/settings', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect((r.body as { error: string }).error).toBeTruthy()
    }
    expect(saved).toEqual([])
  })

  it('accepts only JSON, so a plain HTML form cannot post', async () => {
    const { post, saved } = await setup()
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      '',
    ])
      expect(
        (
          await post(
            '/settings',
            { coverageDistancePercentile: 95 },
            { 'content-type': type },
          )
        ).status,
        type,
      ).toBe(415)
    expect(
      (
        await post(
          '/settings',
          { coverageDistancePercentile: 95 },
          { 'content-type': 'application/json; charset=utf-8' },
        )
      ).status,
    ).toBe(200)
    expect(saved).toHaveLength(1)
  })

  it('answers 503 while the plugin is stopped', async () => {
    const { post, saved } = await setup(true, false)
    const r = await post('/settings', { coverageDistancePercentile: 95 })
    expect(r.status).toBe(503)
    expect(saved).toEqual([])
  })

  it('serves a summary with units in field names', async () => {
    const { call } = await setup()
    const { status, body } = await call('/summary', { window: '1h' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ window: '1h', messages: 20, source: 'live' })
    expect(
      (body as { distance: { p99M: number } }).distance.p99M,
    ).toBeGreaterThan(20 * 1852)
  })

  it('rejects bad parameters with 400', async () => {
    const { call } = await setup()
    expect((await call('/summary', { window: '2h' })).status).toBe(400)
    expect((await call('/sectors', { class: 'c' })).status).toBe(400)
    expect((await call('/series', { metric: 'x' })).status).toBe(400)
    expect(
      (await call('/series', { metric: 'messages', resolution: '10' })).status,
    ).toBe(400)
    expect(
      (await call('/series', { metric: 'messages', from: 'yesterday' })).status,
    ).toBe(400)
    expect(
      (
        await call('/series', {
          metric: 'messages',
          resolution: '60',
          from: '2020-01-01T00:00:00Z',
        })
      ).status,
    ).toBe(400)
    expect((await call('/coverage', { window: '1h' })).status).toBe(400)
  })

  it('serves sectors, series, coverage and status', async () => {
    const { call } = await setup()
    const sectors = (await call('/sectors', { window: '1h', class: 'a' }))
      .body as { sectors: { count: number }[] }
    expect(sectors.sectors[6]!.count).toBe(20)
    const series = (await call('/series', { metric: 'positions' })).body as {
      classA: number[]
    }
    expect(series.classA).toEqual([20])
    const cov = (await call('/coverage', { window: '7d' })).body as {
      cells: number
      areaM2: number
      capM: number | null
      geojson: { features: { properties: { minDistanceM: number } }[] }
    }
    expect(cov.cells).toBeGreaterThan(0)
    expect(cov.areaM2).toBeGreaterThan(1e6)
    expect(cov.geojson.features[0]!.properties.minDistanceM).toBeGreaterThan(
      1000,
    )
    expect(cov.geojson.features).toHaveLength(cov.cells)
    expect((await call('/status')).body).toEqual({ history: false })
  })
})
