import { describe, expect, it } from 'vitest'
import { Aggregator, HOUR_MS, MINUTE_MS } from '../src/aggregate'
import { destination } from '../src/geo'
import { HistoryApiReader, nullHistoryReader } from '../src/history'
import { buildValues } from '../src/publish'
import { HISTORY_FAILED, Query } from '../src/query'
import { OWN } from './fixtures/ais'
import { FakeHistory } from './fixtures/history'

const NM = 1852
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
    expect(s.distance.medianM).toBeGreaterThan(7 * NM)
    expect(s.distance.medianM).toBeLessThan(21 * NM)
    expect(s.distance.p99M).toBeGreaterThan(15 * NM)
    expect(s.distance.p99M).toBeLessThan(26 * NM)
    expect(s.distance.maxM).toBeCloseTo(20 * NM, -1)
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

  it('builds the sectors from sector counters and the highest p99', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 180)
    const q = new Query(agg, () => new HistoryApiReader(history))
    const r = await q.sectors('24h', 'a', T0 + 180 * MINUTE_MS)
    expect(r.sectors).toHaveLength(24)
    expect(r.sectors[3]!.count).toBe(180)
    expect(r.sectors[3]!.p99M).toBeGreaterThan(7 * NM)
    expect(r.sectors[13]!.count).toBe(0)
    const all = await q.sectors('24h', 'all', T0 + 180 * MINUTE_MS)
    expect(all.sectors[13]!.count).toBe(180)
  })

  it('adds the open hour of the sectors from live data, once', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 120)
    // Sector paths go out hourly, so history has nothing of the open hour.
    run(agg, new FakeHistory(), T0 + 120 * MINUTE_MS, 30)
    const q = new Query(agg, () => new HistoryApiReader(history))
    for (const w of ['24h', '7d'] as const) {
      const r = await q.sectors(w, 'a', T0 + 150 * MINUTE_MS)
      expect(r.source).toBe('history')
      expect(r.sectors[3]!.count).toBe(150)
    }
  })

  it('leaves sparse hours out of the sector distances', async () => {
    for (const reader of ['history', 'live'] as const) {
      const history = new FakeHistory()
      const agg = new Aggregator(T0)
      run(agg, history, T0, 120)
      // A third hour with only 5 far reports in the same sector.
      for (let m = 0; m < 60; m++) {
        const t = T0 + (120 + m) * MINUTE_MS
        if (m < 5) agg.add(report(999000003, 50, 40), OWN, t + 1000)
        history.record(buildValues(agg, t + 59_000), t + 59_000)
      }
      const q = new Query(agg, () =>
        reader === 'history'
          ? new HistoryApiReader(history)
          : nullHistoryReader,
      )
      const r = await q.sectors('24h', 'a', T0 + 3 * HOUR_MS + MINUTE_MS)
      expect(r.source).toBe(reader)
      expect(r.sectors[3]!.count).toBe(125)
      expect(r.sectors[3]!.p99M).toBeLessThan(15 * NM)
    }
  })

  it('counts an hour with 20 reports in a sector, but not one with 19', async () => {
    for (const reader of ['history', 'live'] as const)
      for (const [far, counted] of [
        [19, false],
        [20, true],
      ] as const) {
        const history = new FakeHistory()
        const agg = new Aggregator(T0)
        run(agg, history, T0, 120)
        // A third hour with only far reports in the same sector.
        for (let m = 0; m < 60; m++) {
          const t = T0 + (120 + m) * MINUTE_MS
          if (m < far) agg.add(report(999000003, 50, 40), OWN, t + 1000)
          history.record(buildValues(agg, t + 59_000), t + 59_000)
        }
        const q = new Query(agg, () =>
          reader === 'history'
            ? new HistoryApiReader(history)
            : nullHistoryReader,
        )
        const r = await q.sectors('24h', 'a', T0 + 3 * HOUR_MS + MINUTE_MS)
        const p99 = r.sectors[3]!.p99M!
        expect(r.sectors[3]!.count).toBe(120 + far)
        if (counted) expect(p99, `${reader}, ${far}`).toBeGreaterThan(30 * NM)
        else expect(p99, `${reader}, ${far}`).toBeLessThan(15 * NM)
      }
  })

  it('derives the same distance figures from history as from live data', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 180)
    const now = T0 + 180 * MINUTE_MS
    const h = await new Query(agg, () => new HistoryApiReader(history)).summary(
      '24h',
      now,
    )
    const l = await new Query(agg, () => nullHistoryReader).summary('24h', now)
    expect(h.source).toBe('history')
    expect(l.source).toBe('live')
    expect(h.distance.count).toBe(l.distance.count)
    for (const k of ['avgM', 'medianM', 'p95M', 'p99M'] as const)
      expect(h.distance[k], k).toBeCloseTo(l.distance[k]!, 0)
  })

  it('reports the farthest reception per sector with its time', async () => {
    const far = T0 + 30 * MINUTE_MS + 5000
    const build = () => {
      const history = new FakeHistory()
      const agg = new Aggregator(T0)
      for (let m = 0; m < 150; m++) {
        const t = T0 + m * MINUTE_MS
        agg.add(report(999000001, 50, 10), OWN, t + 1000)
        if (m === 30) agg.add(report(999000009, 52, 300), OWN, far)
        history.record(buildValues(agg, t + 59_000), t + 59_000)
      }
      return { history, agg }
    }
    const now = T0 + 150 * MINUTE_MS

    const live = build()
    const l = await new Query(live.agg, () => nullHistoryReader).sectors(
      '24h',
      'a',
      now,
    )
    expect(l.sectors[3]!.maxM).toBeCloseTo(300 * NM, -2)
    expect(l.sectors[3]!.maxAt).toBe(new Date(far).toISOString())
    expect(l.sectors[4]!.maxM).toBeNull()

    const h = build()
    const fromHistory = await new Query(
      h.agg,
      () => new HistoryApiReader(h.history),
    ).sectors('24h', 'a', now)
    expect(fromHistory.source).toBe('history')
    expect(fromHistory.sectors[3]!.maxM).toBeCloseTo(300 * NM, -2)
    expect(fromHistory.sectors[3]!.maxAt).toBeNull()
    expect(fromHistory.sectors[3]!.maxHour).not.toBeNull()

    const maxM = fromHistory.sectors[3]!.maxM!
    const withLog = await new Query(
      h.agg,
      () => new HistoryApiReader(h.history),
      60,
      () => {},
      async () => [
        {
          time: new Date(far).toISOString(),
          mmsi: '999000009',
          cls: 'A',
          distanceM: maxM,
          bearingDeg: 52,
          lat: 0,
          lon: 0,
          ownLat: 0,
          ownLon: 0,
        },
      ],
    ).sectors('24h', 'a', now)
    expect(withLog.sectors[3]!.maxAt).toBe(new Date(far).toISOString())
    expect(withLog.sectors[3]!.maxHour).toBeNull()
  })

  it('starts history series on a whole bucket', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 180)
    const q = new Query(agg, () => new HistoryApiReader(history))
    const from = T0 + 50 * MINUTE_MS
    const s = await q.series('positions', 3600, from, from + 2 * HOUR_MS)
    expect(s.times[0]).toBe(new Date(T0).toISOString())
    expect(s.classA).toEqual([60, 60, 60])
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
    expect((d.maxM as number[])[1]).toBeCloseTo(20 * NM, -1)
  })

  it('agrees between history and live series of positions and vessels', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 180)
    const end = T0 + 3 * HOUR_MS
    const h = new Query(agg, () => new HistoryApiReader(history))
    const l = new Query(agg, () => nullHistoryReader)
    for (const q of [h, l]) {
      const s = await q.series('positions', 3600, T0, end)
      expect(s.classA).toEqual([60, 60, 60])
      expect(s.classB).toEqual([60, 60, 60])
      expect(s.other).toEqual([0, 0, 0])
    }
    const hv = await h.series('vessels', 3600, T0, end)
    expect(hv.source).toBe('history')
    expect((hv.vessels as (number | null)[]).slice(1)).toEqual([2, 2])
    const lv = await l.series('vessels', 3600, T0, end)
    expect(lv.source).toBe('live')
    expect(lv.vessels).toEqual([2, 2, 2])
  })
})

describe('Query when history fails', () => {
  it('answers from live data and says so', async () => {
    const agg = new Aggregator(T0)
    run(agg, new FakeHistory(), T0, 120)
    const errors: unknown[] = []
    const failing = {
      available: true,
      series: async () => {
        throw new Error('global RSS memory limit exceeded')
      },
    }
    const q = new Query(
      agg,
      () => failing,
      300,
      (e) => errors.push(e),
    )
    const now = T0 + 120 * MINUTE_MS
    const s = await q.summary('24h', now)
    expect(s.source).toBe('live')
    expect(s.messages).toBe(240)
    expect(s.historyError).toBe(HISTORY_FAILED)
    expect(s.historyError).not.toContain('memory')
    const r = await q.sectors('24h', 'all', now)
    expect(r.source).toBe('live')
    expect(r.historyError).toBe(HISTORY_FAILED)
    const series = await q.series('messages', 3600, now - 7 * 86400e3, now)
    expect(series.source).toBe('live')
    expect(series.historyError).toBe(HISTORY_FAILED)
    expect(errors).toHaveLength(3)
  })
})

describe('Query resolution', () => {
  it('reads history no finer than the publish interval', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 120)
    const q = new Query(agg, () => new HistoryApiReader(history), 600)
    await q.summary('24h', T0 + 120 * MINUTE_MS)
    const resolutions = history.requests.map((r) => r.resolution)
    expect(Math.min(...(resolutions as number[]))).toBe(600)
  })

  it('answers short chart spans from live data once it covers them', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    run(agg, history, T0, 120)
    const q = new Query(agg, () => new HistoryApiReader(history), 300)
    const now = T0 + 120 * MINUTE_MS
    const s = await q.series('messages', 60, now - HOUR_MS, now)
    expect(s.source).toBe('live')
    expect(history.requests).toHaveLength(0)
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
    const week = await q.summary('7d', now)
    expect(week.vessels).toBeNull()
    const r = await q.sectors('1h', 'b', now)
    expect(r.sectors[13]!.count).toBe(60)
    const s = await q.series('messages', 3600, T0, now)
    expect(s.messages).toEqual([120, 120])
  })

  it('reports no data rather than zeros for distances', async () => {
    const q = new Query(new Aggregator(T0), () => nullHistoryReader)
    const s = await q.summary('1h', T0 + 1000)
    expect(s.messages).toBe(0)
    expect(s.distance.p99M).toBeNull()
    expect(s.distance.maxM).toBeNull()
  })
})

describe('Query message health', () => {
  /** Like `run`, plus one duplicate and one decode error per minute. */
  function runWithHealth(
    agg: Aggregator,
    history: FakeHistory,
    start: number,
    minutes: number,
  ) {
    for (let m = 0; m < minutes; m++) {
      const t = start + m * MINUTE_MS
      agg.add(report(999000001, 50, 10), OWN, t + 1000)
      agg.add(report(999000001, 50, 10), OWN, t + 1500)
      agg.countHealth('duplicates', t + 1500)
      agg.countHealth('decodeErrors', t + 2000)
      history.record(buildValues(agg, t + 59_000), t + 59_000)
    }
  }

  it('totals health counters from history across a restart', async () => {
    const history = new FakeHistory()
    runWithHealth(new Aggregator(T0), history, T0, 120)
    const restart = T0 + 120 * MINUTE_MS
    const agg = new Aggregator(restart)
    runWithHealth(agg, history, restart, 120)
    const q = new Query(agg, () => new HistoryApiReader(history))
    const s = await q.summary('24h', restart + 120 * MINUTE_MS)
    expect(s.source).toBe('history')
    expect(s.health.counts.duplicates).toBe(240)
    expect(s.health.counts.decodeErrors).toBe(240)
    expect(s.health.received).toBe(480 + 240)
    expect(s.distance.count).toBe(480)
  })

  it('agrees between history and live health series', async () => {
    const history = new FakeHistory()
    const agg = new Aggregator(T0)
    runWithHealth(agg, history, T0, 180)
    const now = T0 + 180 * MINUTE_MS
    const from = now - 3 * HOUR_MS
    const h = await new Query(agg, () => new HistoryApiReader(history)).series(
      'health',
      3600,
      from,
      now,
    )
    const l = await new Query(agg, () => nullHistoryReader).series(
      'health',
      3600,
      from,
      now,
    )
    expect(h.source).toBe('history')
    expect(l.source).toBe('live')
    const sum = (r: typeof h, k: string) =>
      (r[k] as number[]).reduce((a, b) => a + b, 0)
    for (const k of ['received', 'duplicates', 'decodeErrors'])
      expect(sum(h, k), k).toBe(sum(l, k))
    expect(sum(l, 'duplicates')).toBe(180)
    expect(sum(l, 'received')).toBe(540)
    expect(l.implausibleJumps).toBeDefined()
  })

  it('answers health from live data without history', async () => {
    const agg = new Aggregator(T0)
    agg.add({ type: 1, mmsi: '999000001' }, OWN, T0 + 1000)
    agg.add(report(999000002, 50, 10), undefined, T0 + 2000)
    agg.countHealth('incomplete', T0 + 3000)
    const s = await new Query(agg, () => nullHistoryReader).summary(
      '24h',
      T0 + 5000,
    )
    expect(s.health).toEqual({
      received: 3,
      counts: {
        decodeErrors: 0,
        incomplete: 1,
        duplicates: 0,
        duplicatesCrossEvent: 0,
        positionInvalid: 1,
        implausibleJumps: 0,
        noOwnPosition: 1,
      },
    })
  })
})
