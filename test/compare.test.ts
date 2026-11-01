// Date ranges for the compare view (#14): the query layer, the coverage
// day files and the routes, with the in-process History API fake.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Aggregator, DAY_MS, HOUR_MS, MINUTE_MS } from '../src/aggregate'
import { registerRoutes } from '../src/api'
import { Coverage, utcDay } from '../src/coverage'
import { destination } from '../src/geo'
import { HistoryApiReader, nullHistoryReader } from '../src/history'
import { buildValues } from '../src/publish'
import { Query } from '../src/query'
import { OWN } from './fixtures/ais'
import { FakeHistory } from './fixtures/history'
import { fakeRouter } from './fixtures/router'

const NM = 1852
const T0 = Date.UTC(2030, 0, 1)
const iso = (t: number) => new Date(t).toISOString()

function report(mmsi: number, bearing: number, nm: number, type = 1) {
  const p = destination(OWN, bearing, nm)
  return { type, mmsi: String(mmsi), lat: p.lat, lon: p.lon }
}

/**
 * One class A report at `nm` bearing 50 and one class B report at 20 nm
 * bearing 205 per minute, published into the fake history every minute.
 */
function run(
  agg: Aggregator,
  history: FakeHistory,
  start: number,
  minutes: number,
  nm = 10,
) {
  for (let m = 0; m < minutes; m++) {
    const t = start + m * MINUTE_MS
    agg.add(report(999000001, 50, nm), OWN, t + 1000)
    agg.add(report(999000002, 205, 20, 18), OWN, t + 2000)
    history.record(buildValues(agg, t + 59_000), t + 59_000)
  }
}

describe('Query ranges', () => {
  it('totals a range of whole hours from history', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 300)
    const q = new Query(agg, () => new HistoryApiReader(history))
    const now = T0 + 300 * MINUTE_MS
    const s = await q.summary({ from: T0 + HOUR_MS, to: T0 + 3 * HOUR_MS }, now)
    expect(s.source).toBe('history')
    expect(s.window).toBeNull()
    expect(s.from).toBe(iso(T0 + HOUR_MS))
    expect(s.to).toBe(iso(T0 + 3 * HOUR_MS))
    expect(s.messages).toBe(240)
    expect(s.positions).toEqual({ classA: 120, classB: 120, other: 0 })
    expect(s.distance.count).toBe(240)
    // Unique vessels are only known for windows ending now.
    expect(s.vessels).toBeNull()
    expect(s.liveFrom).toBeUndefined()
  })

  it('tells two ranges apart, as before and after a change', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 120, 10)
    run(agg, history, T0 + 120 * MINUTE_MS, 120, 40)
    const q = new Query(agg, () => new HistoryApiReader(history))
    const now = T0 + 240 * MINUTE_MS
    const before = await q.summary({ from: T0, to: T0 + 2 * HOUR_MS }, now)
    const after = await q.summary(
      { from: T0 + 2 * HOUR_MS, to: T0 + 4 * HOUR_MS },
      now,
    )
    expect(before.messages).toBe(after.messages)
    expect(before.distance.p99M).toBeLessThan(26 * NM)
    expect(after.distance.p99M).toBeGreaterThan(35 * NM)
  })

  it('ends a range that reaches past now at now', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 90)
    const q = new Query(agg, () => new HistoryApiReader(history))
    const now = T0 + 90 * MINUTE_MS
    const s = await q.summary({ from: T0, to: T0 + 7 * DAY_MS }, now)
    expect(s.to).toBe(iso(now))
    expect(s.messages).toBe(180)
  })

  it('builds sectors of a range from closed hours and the open hour', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 120)
    // The open hour is only in the live buckets.
    run(agg, new FakeHistory(), T0 + 120 * MINUTE_MS, 30)
    const q = new Query(agg, () => new HistoryApiReader(history))
    const now = T0 + 150 * MINUTE_MS
    const closed = await q.sectors({ from: T0, to: T0 + 2 * HOUR_MS }, 'a', now)
    expect(closed.source).toBe('history')
    expect(closed.window).toBeNull()
    expect(closed.sectors[3]!.count).toBe(120)
    expect(closed.sectors[3]!.p99M).toBeGreaterThan(7 * NM)
    const open = await q.sectors(
      { from: T0 + 2 * HOUR_MS, to: T0 + 3 * HOUR_MS },
      'a',
      now,
    )
    expect(open.sectors[3]!.count).toBe(30)
    const both = await q.sectors({ from: T0, to: T0 + 3 * HOUR_MS }, 'all', now)
    expect(both.sectors[3]!.count).toBe(150)
    expect(both.sectors[13]!.count).toBe(150)
  })

  it('answers a range from live hour buckets and says where they start', async () => {
    const agg = new Aggregator(T0)
    run(agg, new FakeHistory(), T0, 180)
    const q = new Query(agg, () => nullHistoryReader)
    const now = T0 + 180 * MINUTE_MS
    const inside = await q.summary(
      { from: T0 + HOUR_MS, to: T0 + 2 * HOUR_MS },
      now,
    )
    expect(inside.source).toBe('live')
    expect(inside.messages).toBe(120)
    expect(inside.liveFrom).toBeUndefined()
    const earlier = await q.summary(
      { from: T0 - 2 * DAY_MS, to: T0 + 2 * HOUR_MS },
      now,
    )
    expect(earlier.messages).toBe(240)
    expect(earlier.liveFrom).toBe(iso(T0))
    const sectors = await q.sectors(
      { from: T0 - DAY_MS, to: T0 + HOUR_MS },
      'a',
      now,
    )
    expect(sectors.source).toBe('live')
    expect(sectors.sectors[3]!.count).toBe(60)
    expect(sectors.liveFrom).toBe(iso(T0))
  })

  it('keeps named windows as they were', async () => {
    const agg = new Aggregator(T0)
    run(agg, new FakeHistory(), T0, 30)
    const q = new Query(agg, () => nullHistoryReader)
    const s = await q.summary('24h', T0 + 30 * MINUTE_MS)
    expect(s.window).toBe('24h')
    expect(s.vessels?.total).toBe(2)
    expect(s.liveFrom).toBeUndefined()
    const r = await q.sectors('24h', 'a', T0 + 30 * MINUTE_MS)
    expect(r.window).toBe('24h')
    expect(r.to).toBe(iso(T0 + 30 * MINUTE_MS))
  })
})

const C0 = Date.UTC(2030, 0, 10, 12)

async function coverageWithDays(retentionDays = 14) {
  const dir = await mkdtemp(join(tmpdir(), 'ais-compare-'))
  // Days 1, 2 and 4 before today have reports; day 3 has none.
  for (const back of [4, 2, 1]) {
    const t = C0 - back * DAY_MS
    const c = new Coverage(dir, 5, retentionDays, 100, t)
    for (let i = 0; i <= back; i++) {
      const p = destination(OWN, i * 40, 10 + i * 5)
      c.add(p.lat, p.lon, 10 + i * 5, t)
    }
    await c.flush()
  }
  const today = new Coverage(dir, 5, retentionDays, 100, C0)
  const p = destination(OWN, 300, 8)
  today.add(p.lat, p.lon, 8, C0)
  return today
}

describe('Coverage.footprintRange', () => {
  it('unites the day files of a range, missing days included', async () => {
    const c = await coverageWithDays()
    const f = await c.footprintRange(
      utcDay(C0 - 4 * DAY_MS),
      utcDay(C0 - 1 * DAY_MS),
      C0,
    )
    expect(f.days).toEqual([
      utcDay(C0 - 4 * DAY_MS),
      utcDay(C0 - 3 * DAY_MS),
      utcDay(C0 - 2 * DAY_MS),
      utcDay(C0 - 1 * DAY_MS),
    ])
    // Day 4 back has 5 cells, day 2 adds none beyond its 3, day 1 its 2:
    // all share the first cells, so the union is the largest day.
    expect(f.cells).toHaveLength(5)
    const one = await c.footprintRange(
      utcDay(C0 - DAY_MS),
      utcDay(C0 - DAY_MS),
      C0,
    )
    expect(one.cells).toHaveLength(2)
  })

  it('includes today from memory and leaves out days after it', async () => {
    const c = await coverageWithDays()
    const f = await c.footprintRange(utcDay(C0), utcDay(C0 + 3 * DAY_MS), C0)
    expect(f.days).toEqual([utcDay(C0)])
    expect(f.cells).toHaveLength(1)
  })

  it('names the oldest kept day', async () => {
    const c = await coverageWithDays(14)
    expect(c.retainedFrom(C0)).toBe(utcDay(C0 - 13 * DAY_MS))
  })
})

describe('compare routes', () => {
  async function setup() {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 180)
    const coverage = await coverageWithDays()
    const f = fakeRouter()
    registerRoutes(f.router, {
      query: () => new Query(agg, () => new HistoryApiReader(history)),
      coverage: () => coverage,
      status: () => ({}),
      now: () => T0 + 180 * MINUTE_MS,
      cacheMs: 0,
    })
    return f
  }

  it('serves a summary and sectors for a from/to range', async () => {
    const { call } = await setup()
    const range = { from: iso(T0 + HOUR_MS), to: iso(T0 + 2 * HOUR_MS) }
    const s = await call('/summary', range)
    expect(s.status).toBe(200)
    expect(s.body).toMatchObject({ window: null, messages: 120 })
    const x = await call('/sectors', { ...range, class: 'all' })
    expect(x.status).toBe(200)
    const sectors = (x.body as { sectors: { count: number }[] }).sectors
    expect(sectors[3]!.count).toBe(60)
  })

  it('rejects ranges that are not whole hours, too long or reversed', async () => {
    const { call } = await setup()
    const bad: Record<string, string>[] = [
      { from: iso(T0) },
      { from: iso(T0), to: iso(T0 + HOUR_MS), window: '24h' },
      { from: 'yesterday', to: iso(T0) },
      { from: iso(T0 + MINUTE_MS), to: iso(T0 + HOUR_MS) },
      { from: iso(T0 + HOUR_MS), to: iso(T0) },
      { from: iso(T0 - 8 * DAY_MS), to: iso(T0) },
      { from: iso(T0 + DAY_MS), to: iso(T0 + 2 * DAY_MS) },
    ]
    for (const q of bad) {
      expect((await call('/summary', q)).status, JSON.stringify(q)).toBe(400)
      expect((await call('/sectors', q)).status, JSON.stringify(q)).toBe(400)
    }
    // Exactly 7 days is allowed.
    expect(
      (await call('/summary', { from: iso(T0 - 7 * DAY_MS), to: iso(T0) }))
        .status,
    ).toBe(200)
  })

  it('serves coverage for UTC days with the oldest kept day', async () => {
    const f = fakeRouter()
    const coverage = await coverageWithDays()
    registerRoutes(f.router, {
      query: () => new Query(new Aggregator(C0), () => nullHistoryReader),
      coverage: () => coverage,
      status: () => ({}),
      now: () => C0,
      cacheMs: 0,
    })
    const r = await f.call('/coverage', {
      from: utcDay(C0 - 4 * DAY_MS),
      to: utcDay(C0 - DAY_MS),
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      window: null,
      from: utcDay(C0 - 4 * DAY_MS),
      to: utcDay(C0 - DAY_MS),
      retainedFrom: utcDay(C0 - 13 * DAY_MS),
      cells: 5,
    })
    const named = await f.call('/coverage', { window: '24h' })
    expect(named.body).toMatchObject({
      window: '24h',
      retainedFrom: utcDay(C0 - 13 * DAY_MS),
    })
    for (const q of [
      { from: '2030-01-05' } as Record<string, string>,
      { from: '2030-01-05', to: '2030-01-04' },
      { from: '2030-01-01', to: '2030-01-08' },
      { from: '2030-02-30', to: '2030-03-01' },
      { from: '20300101', to: '2030-01-02' },
      { from: '2030-01-01', to: '2030-01-02', window: '7d' },
    ])
      expect((await f.call('/coverage', q)).status, JSON.stringify(q)).toBe(400)
    // Seven days, both ends included, is the longest.
    expect(
      (await f.call('/coverage', { from: '2030-01-01', to: '2030-01-07' }))
        .status,
    ).toBe(200)
  })
})
