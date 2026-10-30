import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Aggregator } from '../src/aggregate'
import { registerRoutes } from '../src/api'
import { Coverage } from '../src/coverage'
import { destination } from '../src/geo'
import { nullHistoryReader } from '../src/history'
import { Query } from '../src/query'
import { OWN } from './fixtures/ais'
import { fakeRouter } from './fixtures/router'

const T0 = Date.UTC(2030, 0, 1, 12)

async function setup(withAccess = true) {
  const agg = new Aggregator(T0)
  const coverage = new Coverage(
    await mkdtemp(join(tmpdir(), 'ais-api-')),
    5,
    90,
    99,
    T0,
  )
  for (let i = 0; i < 20; i++) {
    const p = destination(OWN, 100, 10 + i)
    const located = agg.add({ type: 1, mmsi: `99900000${i}`, ...p }, OWN, T0)
    if (located) coverage.add(located.lat, located.lon, located.distanceNm, T0)
  }
  const f = fakeRouter(withAccess)
  registerRoutes(f.router, {
    query: new Query(agg, () => nullHistoryReader),
    coverage: () => coverage,
    status: () => ({ history: false }),
    now: () => T0 + 1000,
  })
  return f
}

describe('REST API', () => {
  it('registers every route read-only', async () => {
    const { routes } = await setup()
    expect([...routes.keys()].sort()).toEqual([
      '/coverage',
      '/radar',
      '/series',
      '/status',
      '/summary',
    ])
    for (const r of routes.values()) expect(r.access).toBe('readonly')
  })

  it('falls back to admin-only routes on servers without access()', async () => {
    const { routes } = await setup(false)
    for (const r of routes.values()) expect(r.access).toBe('admin')
  })

  it('serves a summary with units in field names', async () => {
    const { call } = await setup()
    const { status, body } = await call('/summary', { window: '1h' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ window: '1h', messages: 20, source: 'live' })
    expect(
      (body as { distance: { p99Nm: number } }).distance.p99Nm,
    ).toBeGreaterThan(20)
  })

  it('rejects bad parameters with 400', async () => {
    const { call } = await setup()
    expect((await call('/summary', { window: '2h' })).status).toBe(400)
    expect((await call('/radar', { class: 'c' })).status).toBe(400)
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

  it('serves radar, series, coverage and status', async () => {
    const { call } = await setup()
    const radar = (await call('/radar', { window: '1h', class: 'a' })).body as {
      sectors: { count: number }[]
    }
    expect(radar.sectors[6]!.count).toBe(20)
    const series = (await call('/series', { metric: 'positions' })).body as {
      classA: number[]
    }
    expect(series.classA).toEqual([20])
    const cov = (await call('/coverage', { window: '7d' })).body as {
      cells: number
      geojson: { features: unknown[] }
    }
    expect(cov.cells).toBeGreaterThan(0)
    expect(cov.geojson.features).toHaveLength(cov.cells)
    expect((await call('/status')).body).toEqual({ history: false })
  })
})
