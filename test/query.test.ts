import { describe, expect, it } from 'vitest'
import { Aggregator, HOUR_MS, MINUTE_MS } from '../src/aggregate'
import { destination } from '../src/geo'
import { HistoryApiReader, nullHistoryReader } from '../src/history'
import { buildValues } from '../src/publish'
import { Query } from '../src/query'
import { OWN } from './fixtures/ais'
import { FakeHistory } from './fixtures/history'

const T0 = Date.UTC(2030, 0, 1)

function report(mmsi: number, bearing: number, nm: number, type = 1) {
  const p = destination(OWN, bearing, nm)
  return { type, mmsi: String(mmsi), lat: p.lat, lon: p.lon }
}

/**
 * Runs a plugin for `minutes`, one class A report at 10 nm bearing 50 and
 * one class B report at 20 nm bearing 205 per minute, publishing into the
 * fake history every minute like the plugin does.
 */
function run(
  agg: Aggregator,
  history: FakeHistory,
  start: number,
  minutes: number,
) {
  for (let m = 0; m < minutes; m++) {
    const t = start + m * MINUTE_MS
    agg.add(report(999000001, 50, 10), OWN, t + 1000)
    agg.add(report(999000002, 205, 20, 18), OWN, t + 2000)
    history.record(buildValues(agg, t + 59_000), t + 59_000)
  }
}

describe('Query with history', () => {
  it('totals counters across a plugin restart', async () => {
    const history = new FakeHistory()
    run(new Aggregator(T0), history, T0, 300)
    // Restart: counters begin at zero again.
    const restart = T0 + 300 * MINUTE_MS
    const agg = new Aggregator(restart)
    run(agg, history, restart, 300)
    const now = restart + 300 * MINUTE_MS
    const q = new Query(agg, () => new HistoryApiReader(history))
    const s = await q.summary('24h', now)
    expect(s.source).toBe('history')
    expect(s.messages).toBe(1200)
    expect(s.positions).toEqual({ classA: 600, classB: 600, other: 0 })
    expect(s.distance.count).toBe(1200)
    expect(s.distance.medianNm).toBeGreaterThan(7)
    expect(s.distance.medianNm).toBeLessThan(21)
    expect(s.distance.p99Nm).toBeGreaterThan(15)
    expect(s.distance.p99Nm).toBeLessThan(26)
    expect(s.distance.maxNm).toBeCloseTo(20, 3)
    expect(s.vessels?.total).toBe(2)
  })

  it('totals a restart inside a summary bucket', async () => {
    const history = new FakeHistory()
    run(new Aggregator(T0), history, T0, 7)
    const restart = T0 + 7 * MINUTE_MS + 20_000
    const agg = new Aggregator(restart)
    run(agg, history, restart, 6)
    const now = restart + 6 * MINUTE_MS
    const q = new Query(agg, () => new HistoryApiReader(history))
    const s = await q.summary('24h', now)
    expect(s.messages).toBe(26)
  })

  it('builds the radar from sector counters and the highest p99', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 180)
    const q = new Query(agg, () => new HistoryApiReader(history))
    const r = await q.radar('24h', 'a', T0 + 180 * MINUTE_MS)
    expect(r.sectors).toHaveLength(24)
    expect(r.sectors[3]!.count).toBe(180)
    expect(r.sectors[3]!.p99Nm).toBeGreaterThan(7)
    expect(r.sectors[13]!.count).toBe(0)
    const all = await q.radar('24h', 'all', T0 + 180 * MINUTE_MS)
    expect(all.sectors[13]!.count).toBe(180)
  })

  it('returns hourly series of positions and distance', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 180)
    const q = new Query(agg, () => new HistoryApiReader(history))
    const s = await q.series('positions', 3600, T0, T0 + 3 * HOUR_MS)
    expect(s.source).toBe('history')
    expect(s.classA).toEqual([60, 60, 60])
    const d = await q.series('distance', 3600, T0, T0 + 3 * HOUR_MS)
    expect((d.count as number[])[1]).toBe(120)
    expect((d.maxNm as number[])[1]).toBeCloseTo(20, 3)
  })
})

describe('Query in live-only mode', () => {
  it('answers windows from the aggregator', async () => {
    const agg = new Aggregator(T0)
    run(agg, new FakeHistory(), T0, 120)
    const q = new Query(agg, () => nullHistoryReader)
    const now = T0 + 120 * MINUTE_MS
    const day = await q.summary('24h', now)
    expect(day.source).toBe('live')
    expect(day.messages).toBe(240)
    const hour = await q.summary('1h', now)
    expect(hour.messages).toBe(120)
    const month = await q.summary('30d', now)
    expect(month.vessels).toBeNull()
    const r = await q.radar('1h', 'b', now)
    expect(r.sectors[13]!.count).toBe(60)
    const s = await q.series('messages', 3600, T0, now)
    expect(s.messages).toEqual([120, 120])
  })

  it('reports no data rather than zeros for distances', async () => {
    const q = new Query(new Aggregator(T0), () => nullHistoryReader)
    const s = await q.summary('1h', T0 + 1000)
    expect(s.messages).toBe(0)
    expect(s.distance.p99Nm).toBeNull()
    expect(s.distance.maxNm).toBeNull()
  })
})
