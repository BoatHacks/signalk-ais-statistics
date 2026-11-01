import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { latLngToCell } from 'h3-js'
import { binOf, emptyBins } from '../src/histogram'
import { Aggregator, DAY_MS } from '../src/aggregate'
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
      '/export/coverage.csv',
      '/export/longrange.csv',
      '/export/longrange.geojson',
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
    expect(r.body).toMatchObject({ fastest: [], implausibleJumps: [] })
    expect((await call('/longrange', { window: '1h' })).status).toBe(400)
  })

  it('falls back to admin-only routes on servers without access()', async () => {
    const { routes } = await setup(false)
    expect(routes.has('POST /settings')).toBe(true)
    for (const r of routes.values()) expect(r.access).toBe('admin')
  })

  it('tries a coverage cap without saving it', async () => {
    const { call, saved } = await setup()
    type Cov = {
      cappedCells: number
      capM: number | null
      capPercentile: number
    }
    const base = (await call('/coverage')).body as Cov
    expect(base.cappedCells).toBe(1)
    expect(base.capPercentile).toBe(99)
    const open = (await call('/coverage', { cap: '100' })).body as Cov
    expect(open.cappedCells).toBe(0)
    expect(open.capM).toBeNull()
    expect(open.capPercentile).toBe(100)
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
    expect(r).toMatchObject({
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

describe('REST API downloads', () => {
  // A cell well away from today's reports, seen 10 days ago.
  const OLD_CELL = latLngToCell(1, 1, 5)
  const day = (offset: number) =>
    new Date(T0 + offset * DAY_MS).toISOString().slice(0, 10)

  async function exportSetup(running = true) {
    const covDir = await mkdtemp(join(tmpdir(), 'ais-export-'))
    const lrDir = await mkdtemp(join(tmpdir(), 'ais-export-'))
    // Older day files: one inside the 14 day retention, one already outside.
    const old = (date: string, mmsi: string, distanceM: number) =>
      writeFile(
        join(lrDir, `longrange-${date}.json`),
        JSON.stringify({
          version: 2,
          date,
          entries: [
            {
              time: `${date}T06:00:00.000Z`,
              mmsi,
              cls: 'A',
              distanceM,
              bearingDeg: 90,
              lat: 0,
              lon: 1,
              ownLat: 0,
              ownLon: 0,
            },
          ],
          fastest: [],
        }),
      )
    await old(day(-10), '999000101', 111000)
    await old(day(-20), '999000102', 112000)
    await writeFile(
      join(covDir, `coverage-${day(-10)}.json`),
      JSON.stringify({
        version: 1,
        date: day(-10),
        resolution: 5,
        cells: { [OLD_CELL]: [5, 2] },
        distanceBins: emptyBins().map((n, i) => (i === binOf(5) ? 2 : n)),
      }),
    )
    const agg = new Aggregator(T0)
    const coverage = new Coverage(covDir, 5, 14, 99, T0)
    const longRange = new LongRangeLog(lrDir, 14, T0)
    for (let i = 0; i < 5; i++) {
      const p = destination(OWN, 100, 10 + i)
      const located = agg.add({ type: 1, mmsi: `99900000${i}`, ...p }, OWN, T0)
      if (located) {
        coverage.add(located.lat, located.lon, located.distanceNm, T0)
        longRange.add(located, { name: i === 0 ? '=SYNTHETIC' : undefined })
      }
    }
    const f = fakeRouter()
    registerRoutes(f.router, {
      query: () =>
        running ? new Query(agg, () => nullHistoryReader) : undefined,
      coverage: () => (running ? coverage : undefined),
      longRange: () => (running ? longRange : undefined),
      retentionDays: () => (running ? 14 : undefined),
      status: () => ({}),
      now: () => T0 + 1000,
    })
    return f
  }

  const rows = (body: unknown) => String(body).split('\r\n').slice(0, -1)

  it('sends coverage as a CSV attachment named by window and day', async () => {
    const { call } = await exportSetup()
    const r = await call('/export/coverage.csv', { window: '7d' })
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['content-disposition']).toBe(
      `attachment; filename="ais-coverage-7d-${day(0)}.csv"`,
    )
    expect(rows(r.body)[0]).toBe(
      'h3_cell,resolution,reports,min_distance_m,capped',
    )
    expect(rows(r.body).length).toBeGreaterThan(1)
  })

  it('reaches every retained coverage day with window=all', async () => {
    const { call } = await exportSetup()
    const week = rows(
      (await call('/export/coverage.csv', { window: '7d' })).body,
    )
    const all = rows(
      (await call('/export/coverage.csv', { window: 'all' })).body,
    )
    expect(week.join()).not.toContain(OLD_CELL)
    expect(all.join()).toContain(OLD_CELL)
    const named = await call('/export/coverage.csv', {
      window: 'all',
      all: 'true',
    })
    expect(named.headers['content-disposition']).toContain(
      `ais-coverage-allcells-all-${day(0)}.csv`,
    )
  })

  it('sends every long-range entry in the window, oldest first', async () => {
    const { call } = await exportSetup()
    const today = rows(
      (await call('/export/longrange.csv', { window: '24h' })).body,
    )
    expect(today).toHaveLength(6)
    expect(today.join('\n')).toContain("'=SYNTHETIC")
    const all = rows(
      (await call('/export/longrange.csv', { window: 'all' })).body,
    )
    expect(all).toHaveLength(7)
    expect(all[1]).toContain('999000101')
    expect(all.join()).not.toContain('999000102')
  })

  it('anonymises the long-range CSV and names the file so', async () => {
    const { call } = await exportSetup()
    const r = await call('/export/longrange.csv', {
      window: '7d',
      anonymise: 'true',
    })
    expect(rows(r.body)[0]).toBe('time,class,ship_type,distance_m,bearing_deg')
    expect(String(r.body)).not.toContain('99900000')
    expect(r.headers['content-disposition']).toContain(
      `ais-longrange-7d-${day(0)}-anon.csv`,
    )
  })

  it('sends long-range GeoJSON, full detail only', async () => {
    const { call } = await exportSetup()
    const r = await call('/export/longrange.geojson', { window: 'all' })
    expect(r.headers['content-type']).toBe('application/geo+json')
    const g = JSON.parse(String(r.body)) as { features: unknown[] }
    expect(g.features).toHaveLength(6)
    expect(
      (await call('/export/longrange.geojson', { anonymise: 'true' })).status,
    ).toBe(400)
  })

  it('rejects bad parameters and answers 503 when stopped', async () => {
    const { call } = await exportSetup()
    for (const path of [
      '/export/coverage.csv',
      '/export/longrange.csv',
      '/export/longrange.geojson',
    ])
      expect((await call(path, { window: '1h' })).status, path).toBe(400)
    expect(
      (await call('/export/longrange.csv', { anonymise: 'yes' })).status,
    ).toBe(400)
    expect((await call('/export/coverage.csv', { all: '1' })).status).toBe(400)
    const stopped = await exportSetup(false)
    for (const path of [
      '/export/coverage.csv',
      '/export/longrange.csv',
      '/export/longrange.geojson',
    ])
      expect((await stopped.call(path)).status, path).toBe(503)
  })
})
