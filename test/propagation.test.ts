import { describe, expect, it } from 'vitest'
import { Aggregator, HOUR_MS, MINUTE_MS } from '../src/aggregate'
import { M_PER_NM, destination } from '../src/geo'
import {
  CHECKS_KEPT,
  MIN_BASELINE_HOURS,
  PropagationDetector,
  alertMessage,
  baselineFrom,
  median,
  notificationValue,
  replay,
  step,
  type Check,
  type Rule,
} from '../src/propagation'
import { OWN } from './fixtures/ais'

const T0 = Date.UTC(2030, 0, 1, 12)
const RULE: Rule = { factor: 2, minVessels: 3, sustainMinutes: 15 }

const iso = (t: number) => new Date(t).toISOString()

/** An hourly series as Query.series answers it, every hour the same. */
function hours(n: number, p99Nm: number, count = 50, end = T0) {
  const times: string[] = []
  for (let i = n; i >= 1; i--) times.push(iso(end - i * HOUR_MS))
  return {
    times,
    count: times.map(() => count),
    p99M: times.map(() => p99Nm * M_PER_NM),
    maxM: times.map(() => p99Nm * 1.2 * M_PER_NM),
  }
}

/** A located report from a synthetic sender. */
function report(i: number, nm: number, time: number, bearing = 90) {
  return {
    mmsi: `9990${String(i).padStart(5, '0')}`,
    distanceNm: nm,
    bearingDeg: bearing,
    time,
  }
}

/**
 * One minute of reports into the aggregator and the detector: `near`
 * senders at 10 nm and `far` senders at `farNm`.
 */
function minute(
  agg: Aggregator,
  d: PropagationDetector,
  time: number,
  near: number,
  far: number,
  farNm = 40,
) {
  const add = (i: number, nm: number, bearing: number) => {
    const p = destination(OWN, bearing, nm)
    const l = agg.add(
      { type: 1, mmsi: `9990${String(i).padStart(5, '0')}`, ...p },
      OWN,
      time,
    )
    if (l) d.see(l)
  }
  for (let i = 0; i < near; i++) add(i, 10, 180)
  for (let i = 0; i < far; i++) add(100 + i, farNm, 35)
}

describe('median', () => {
  it('takes the middle value, or the mean of the two middle ones', () => {
    expect(median([])).toBeUndefined()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('baselineFrom', () => {
  it('is the median hourly p99 of hours that ended', () => {
    const s = hours(30, 10)
    s.p99M[0] = 50 * M_PER_NM
    s.maxM[0] = 60 * M_PER_NM
    // The open hour does not count.
    s.times.push(iso(T0))
    s.count.push(500)
    s.p99M.push(500 * M_PER_NM)
    s.maxM.push(500 * M_PER_NM)
    const b = baselineFrom(s, T0 + 10 * MINUTE_MS)!
    expect(b.hours).toBe(30)
    expect(b.nm).toBeCloseTo(10)
  })

  it('leaves out hours with fewer than 20 reports', () => {
    const s = hours(30, 10)
    for (let i = 0; i < 10; i++) {
      s.count[i] = 19
      s.p99M[i] = 80 * M_PER_NM
    }
    const b = baselineFrom(s, T0)!
    expect(b.hours).toBe(20)
    expect(b.nm).toBeCloseTo(10)
  })

  it('caps each hour at its farthest reception', () => {
    const s = hours(3, 10)
    s.maxM = s.times.map(() => 8 * M_PER_NM)
    expect(baselineFrom(s, T0)!.nm).toBeCloseTo(8)
  })

  it('is undefined without a qualifying hour', () => {
    expect(baselineFrom(hours(5, 10, 3), T0)).toBeUndefined()
    expect(baselineFrom({ times: [] }, T0)).toBeUndefined()
  })
})

describe('the alert rule', () => {
  const check = (
    minute: number,
    ratio: number | null,
    vessels: number,
    armed = true,
  ): Check => ({
    time: T0 + minute * MINUTE_MS,
    armed,
    ratio,
    vessels,
  })

  it('fires only after the conditions held for the sustain time', () => {
    let s = { active: false }
    for (let m = 0; m < 15; m++) {
      s = step(s, check(m, 2.5, 4), RULE)
      expect(s.active, `minute ${m}`).toBe(false)
    }
    s = step(s, check(15, 2.5, 4), RULE)
    expect(s.active).toBe(true)
  })

  it('starts the sustain time again after a break', () => {
    const list = [
      ...Array.from({ length: 10 }, (_, m) => check(m, 3, 5)),
      check(10, 1.5, 5),
      ...Array.from({ length: 15 }, (_, m) => check(11 + m, 3, 5)),
    ]
    expect(replay(list, RULE).active).toBe(false)
    expect(replay([...list, check(26, 3, 5)], RULE).active).toBe(true)
  })

  it('clears once the conditions failed for the sustain time', () => {
    const on = Array.from({ length: 16 }, (_, m) => check(m, 3, 5))
    const off = Array.from({ length: 15 }, (_, m) => check(16 + m, 1, 0))
    expect(replay([...on, ...off], RULE).active).toBe(true)
    expect(replay([...on, ...off, check(31, 1, 0)], RULE).active).toBe(false)
  })

  it('needs enough vessels, the factor and an armed baseline', () => {
    const run = (ratio: number | null, vessels: number, armed = true) =>
      replay(
        Array.from({ length: 20 }, (_, m) => check(m, ratio, vessels, armed)),
        RULE,
      ).active
    expect(run(3, 3)).toBe(true)
    expect(run(3, 2)).toBe(false)
    expect(run(1.9, 10)).toBe(false)
    expect(run(null, 10)).toBe(false)
    expect(run(3, 10, false)).toBe(false)
  })
})

describe('PropagationDetector', () => {
  const settings = { ...RULE, windowMinutes: 15 }

  /** A detector with a 10 nm baseline over enough hours. */
  function armed() {
    const agg = new Aggregator(T0 - 2 * HOUR_MS)
    const d = new PropagationDetector(settings)
    d.setBaseline({ nm: 10, hours: MIN_BASELINE_HOURS })
    return { agg, d }
  }

  /** Runs `n` minutes of reports with a check after each. */
  function run(
    agg: Aggregator,
    d: PropagationDetector,
    from: number,
    n: number,
    near: number,
    far: number,
    farNm = 40,
  ) {
    for (let m = 0; m < n; m++) {
      const t = from + m * MINUTE_MS
      minute(agg, d, t, near, far, farNm)
      d.check(t + 30_000, agg.minuteBuckets(t + 30_000))
    }
  }

  it('stays unarmed until 24 qualifying hours are known', () => {
    const agg = new Aggregator(T0)
    const d = new PropagationDetector(settings)
    expect(d.state('unknown', true)).toBe('unarmed')
    d.setBaseline({ nm: 10, hours: MIN_BASELINE_HOURS - 1 })
    run(agg, d, T0, 30, 10, 5)
    expect(d.state('unknown', true)).toBe('unarmed')
    expect(d.ratio()).toBeGreaterThan(2)
    d.setBaseline({ nm: 10, hours: MIN_BASELINE_HOURS })
    expect(d.state('unknown', true)).toBe('normal')
  })

  it('fires with enough vessels beyond normal for the sustain time', () => {
    const { agg, d } = armed()
    run(agg, d, T0, 15, 10, 5)
    expect(d.state('unknown', true)).toBe('normal')
    run(agg, d, T0 + 15 * MINUTE_MS, 1, 10, 5)
    expect(d.state('unknown', true)).toBe('alert')
    const s = d.status('unknown', true)
    expect(s.vessels).toBe(5)
    expect(s.sectors).toEqual(['030'])
    expect(s.ratio).toBeGreaterThanOrEqual(2)
    expect(s.baselineM).toBe(Math.round(10 * M_PER_NM))
    expect(s.since).toBe(iso(T0 + 15 * MINUTE_MS + 30_000))
    expect(alertMessage(s)).toMatch(
      /^AIS range \d+\.\d times normal: p99 \d+ nm against 10 nm, 5 vessels beyond normal, from sectors 030$/,
    )
  })

  it('never fires on one sender with a bogus far position', () => {
    const { agg, d } = armed()
    run(agg, d, T0, 40, 10, 1, 3000)
    expect(d.ratio()).toBeGreaterThan(2)
    expect(d.status('unknown', true).vessels).toBe(1)
    expect(d.state('unknown', true)).toBe('normal')
  })

  it('does not fire with fewer vessels than the minimum', () => {
    const { agg, d } = armed()
    run(agg, d, T0, 40, 10, 2)
    expect(d.state('unknown', true)).toBe('normal')
    d.setRule({ ...RULE, minVessels: 2 })
    run(agg, d, T0 + 40 * MINUTE_MS, 16, 10, 2)
    expect(d.state('unknown', true)).toBe('alert')
  })

  it('clears once range is back to normal for the sustain time', () => {
    const { agg, d } = armed()
    run(agg, d, T0, 20, 10, 5)
    expect(d.state('unknown', true)).toBe('alert')
    // The far senders leave the 15 minute window before the ratio falls.
    run(agg, d, T0 + 20 * MINUTE_MS, 40, 10, 0)
    expect(d.state('unknown', true)).toBe('normal')
  })

  it('holds the alert back while underway, if set', () => {
    const { agg, d } = armed()
    run(agg, d, T0, 20, 10, 5)
    expect(d.state('underway', true)).toBe('suppressed')
    expect(d.state('underway', false)).toBe('alert')
    expect(d.state('stationary', true)).toBe('alert')
    expect(d.state('unknown', true)).toBe('alert')
  })

  it('keeps the last hour of checks', () => {
    const { agg, d } = armed()
    run(agg, d, T0, CHECKS_KEPT + 5, 10, 0)
    const checks = d.status('unknown', true).checks
    expect(checks).toHaveLength(CHECKS_KEPT)
    expect(checks[0]!.time).toBe(iso(T0 + 5 * MINUTE_MS + 30_000))
  })

  it('takes the recent p99 from the window only', () => {
    const { agg, d } = armed()
    // Far reports an hour ago, near ones now.
    run(agg, d, T0, 10, 10, 5)
    run(agg, d, T0 + 30 * MINUTE_MS, 15, 20, 0)
    expect(d.ratio()).toBeCloseTo(1, 0)
    expect(d.status('unknown', true).vessels).toBe(0)
  })

  it('counts each sender once, by its farthest report in the window', () => {
    const d = new PropagationDetector(settings)
    d.setBaseline({ nm: 10, hours: 30 })
    d.see(report(1, 30, T0, 10))
    d.see(report(1, 50, T0 + 1000, 100))
    d.see(report(2, 5, T0))
    d.check(T0 + MINUTE_MS, [])
    const s = d.status('unknown', true)
    expect(s.vessels).toBe(1)
    expect(s.sectors).toEqual(['090'])
  })
})

describe('notificationValue', () => {
  it('carries the state and methods while active, normal otherwise', () => {
    expect(notificationValue(true, 'warn', ['visual'], 'm')).toEqual({
      state: 'warn',
      method: ['visual'],
      message: 'm',
    })
    expect(notificationValue(false, 'alarm', ['sound'], 'n')).toEqual({
      state: 'normal',
      method: [],
      message: 'n',
    })
  })
})
