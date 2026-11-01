import { AisEncode } from 'ggencoder'
import { describe, expect, it } from 'vitest'
import { Aggregator, HOUR_MS } from '../src/aggregate'
import { M_PER_NM, destination } from '../src/geo'
import {
  ANCHOR_MAX_AGE_MS,
  Health,
  limitFor,
  limitsFromKnots,
} from '../src/health'
import { Ingest, MPS_PER_KNOT, sogFromKnots } from '../src/ingest'
import { N2kIngest } from '../src/n2k'
import { classA, OWN, staticB } from './fixtures/ais'
import { classAPgn } from './fixtures/n2k'

const T0 = Date.UTC(2030, 0, 1, 12)
const KN = MPS_PER_KNOT
const LIMITS = limitsFromKnots(60, 120, 600)

const health = () => new Health(LIMITS, HOUR_MS)

function pos(mmsi: string, nm: number, bearing = 90, type = 1) {
  return { type, mmsi, ...destination(OWN, bearing, nm) }
}

describe('reported SOG', () => {
  it('comes from sentences in knots and from PGNs in m/s', () => {
    const fromSentence = new Ingest().push(classA(999000001, 0.1, 0.1))!
    expect(fromSentence.sogMps).toBeCloseTo(5 * KN, 6)
    const fromPgn = new N2kIngest().push(classAPgn(999000001, 0.1, 0.1))!
    expect(fromPgn.sogMps).toBeCloseTo(2.5, 6)
  })

  it('leaves out the "not available" value', () => {
    const e = new AisEncode({ aistype: 1, mmsi: 999000002, lat: 0, lon: 0 })
    expect(new Ingest().push(e.nmea)!.sogMps).toBeUndefined()
    expect(sogFromKnots(1, 102.3)).toBeUndefined()
    expect(sogFromKnots(1, 102.2)).toBeCloseTo(102.2 * KN, 6)
    expect(sogFromKnots(9, 1023)).toBeUndefined()
    expect(sogFromKnots(9, 350)).toBeCloseTo(350 * KN, 6)
    expect(sogFromKnots(1, -1)).toBeUndefined()
    expect(sogFromKnots(1, Number.NaN)).toBeUndefined()
  })

  it('is only taken from position reports', () => {
    expect(sogFromKnots(5, 10)).toBeUndefined()
    expect(sogFromKnots(18, 10)).toBeCloseTo(10 * KN, 6)
  })
})

describe('duplicate detector', () => {
  it('matches one message decoded from a sentence and from a PGN', () => {
    const h = health()
    const s = new Ingest().push(classA(999000010, 0.1, 0.2))!
    const p = new N2kIngest().push(classAPgn(999000010, 0.1, 0.2))!
    expect(h.check(s, 'nmea0183', undefined, T0).duplicate).toBeUndefined()
    expect(h.check(p, 'N2KAnalyzerOut', undefined, T0 + 500).duplicate).toBe(
      'crossEvent',
    )
  })

  it('tells same-event copies from cross-event ones', () => {
    const h = health()
    const m = pos('999000011', 5)
    h.check(m, 'a', undefined, T0)
    expect(h.check(m, 'a', undefined, T0 + 100).duplicate).toBe('sameEvent')
    // A first copy on another event is a cross-event duplicate.
    expect(h.check(m, 'b', undefined, T0 + 200).duplicate).toBe('crossEvent')
    expect(h.check(m, 'b', undefined, T0 + 300).duplicate).toBe('sameEvent')
    const n = pos('999000012', 5)
    h.check(n, 'a', undefined, T0)
    expect(h.check(n, 'b', undefined, T0 + 100).duplicate).toBe('crossEvent')
  })

  it('needs the copy within 2 seconds', () => {
    const h = health()
    const m = pos('999000013', 5)
    h.check(m, 'a', undefined, T0)
    expect(h.check(m, 'a', undefined, T0 + 2100).duplicate).toBeUndefined()
    expect(h.check(m, 'a', undefined, T0 + 4000).duplicate).toBe('sameEvent')
  })

  it('needs the same type and nearly the same position', () => {
    const h = health()
    const m = pos('999000014', 5)
    h.check(m, 'a', undefined, T0)
    expect(
      h.check({ ...m, type: 3 }, 'a', undefined, T0 + 100).duplicate,
    ).toBeUndefined()
    expect(
      h.check({ ...m, lat: m.lat + 1e-4 }, 'a', undefined, T0 + 200).duplicate,
    ).toBeUndefined()
    expect(
      h.check({ ...m, lat: m.lat + 1e-5 }, 'a', undefined, T0 + 300).duplicate,
    ).toBe('sameEvent')
    expect(
      h.check({ ...m, mmsi: '999000015' }, 'a', undefined, T0 + 400).duplicate,
    ).toBeUndefined()
  })

  it('matches messages without a position on MMSI and type', () => {
    const h = health()
    const m = { type: 5, mmsi: '999000016', shipType: 70 }
    h.check(m, 'a', undefined, T0)
    expect(h.check(m, 'a', undefined, T0 + 1000).duplicate).toBe('sameEvent')
    // A position report is not a copy of a message without one.
    const p = { type: 1, mmsi: '999000017' }
    h.check(p, 'a', undefined, T0)
    expect(
      h.check({ ...p, lat: 0, lon: 0 }, 'a', undefined, T0 + 10).duplicate,
    ).toBeUndefined()
  })

  it('knows the part of a message 24 sentence', () => {
    expect(new Ingest().push(staticB(999000019, 37))).toMatchObject({
      type: 24,
      part: 'B',
    })
  })

  it('keeps the two parts of a message 24 apart', () => {
    const h = health()
    const a = { type: 24, mmsi: '999000018', part: 'A' as const, name: 'X' }
    const b = { type: 24, mmsi: '999000018', part: 'B' as const, shipType: 37 }
    h.check(a, 'a', undefined, T0)
    expect(h.check(b, 'a', undefined, T0 + 100).duplicate).toBeUndefined()
    expect(h.check(b, 'a', undefined, T0 + 200).duplicate).toBe('sameEvent')
  })

  it('forgets copies older than the window', () => {
    const h = health()
    for (let i = 0; i < 1000; i++)
      h.check(pos(String(999100000 + i), 5), 'a', undefined, T0 + i * 10)
    const m = pos('999100000', 5)
    expect(h.check(m, 'a', undefined, T0 + 20_000).duplicate).toBeUndefined()
  })
})

describe('jump limits', () => {
  it('raise the limit for high-speed craft, WIG craft and SAR aircraft', () => {
    expect(limitFor(LIMITS, 1, undefined)).toBeCloseTo(60 * KN)
    expect(limitFor(LIMITS, 1, 70)).toBeCloseTo(60 * KN)
    expect(limitFor(LIMITS, 1, 45)).toBeCloseTo(120 * KN)
    expect(limitFor(LIMITS, 18, 20)).toBeCloseTo(120 * KN)
    expect(limitFor(LIMITS, 1, 29)).toBeCloseTo(120 * KN)
    expect(limitFor(LIMITS, 1, 50)).toBeCloseTo(60 * KN)
    expect(limitFor(LIMITS, 9, undefined)).toBeCloseTo(600 * KN)
  })
})

describe('jump tracker', () => {
  /** Two positions `nm` apart, `seconds` apart. */
  function jump(
    h: Health,
    nm: number,
    seconds: number,
    type = 1,
    shipType?: number,
    mmsi = '999000020',
  ) {
    h.check(pos(mmsi, 5, 90, type), 'a', shipType, T0)
    return h.check(
      { ...pos(mmsi, 5 + nm, 90, type), sogMps: 3 },
      'a',
      shipType,
      T0 + seconds * 1000,
    ).speed
  }

  it('measures the implied speed with the reported SOG beside it', () => {
    const s = jump(health(), 1, 120)!
    expect(s.speedMps).toBeCloseTo(M_PER_NM / 120, 1)
    expect(s.sogMps).toBe(3)
    expect(s.gapS).toBe(120)
    expect(s.implausible).toBe(false)
    expect(s.fromLon).toBeLessThan(s.lon)
  })

  it('marks a speed above the sender limit as implausible', () => {
    // 1 nm in 30 s is 120 kn.
    expect(jump(health(), 1, 30)!.implausible).toBe(true)
    expect(jump(health(), 1, 30, 1, 70)!.implausible).toBe(true)
    expect(jump(health(), 1, 40, 1, 45)!.implausible).toBe(false)
    expect(jump(health(), 1, 40, 1, 25)!.implausible).toBe(false)
    expect(jump(health(), 1, 30, 9)!.implausible).toBe(false)
    expect(jump(health(), 10, 30, 9)!.implausible).toBe(true)
  })

  it('ignores movements below 500 m and gaps below a second', () => {
    expect(jump(health(), 0.2, 1)).toBeUndefined()
    expect(jump(health(), 5, 0.5)).toBeUndefined()
  })

  it('counts one bogus position twice, out and back', () => {
    const h = health()
    const m = '999000021'
    h.check(pos(m, 5), 'a', undefined, T0)
    const out = h.check(pos(m, 300), 'a', undefined, T0 + 10_000).speed
    const back = h.check(pos(m, 5.01), 'a', undefined, T0 + 20_000).speed
    expect(out?.implausible).toBe(true)
    expect(back?.implausible).toBe(true)
  })

  it('measures a fast vessel that reports every 2 s over 500 m', () => {
    const h = health()
    const m = '999000022'
    const kn = 40
    const samples = []
    for (let i = 0; i <= 30; i++) {
      const nm = 5 + (kn * 2 * i) / 3600
      const r = h.check(pos(m, nm), 'a', undefined, T0 + i * 2000)
      if (r.speed) samples.push(r.speed)
    }
    expect(samples.length).toBeGreaterThan(0)
    for (const s of samples) {
      expect(s.speedMps / KN).toBeCloseTo(kn, 0)
      expect(s.implausible).toBe(false)
    }
  })

  it('judges a bogus position against a recent anchor', () => {
    const h = health()
    const m = '999000023'
    // At anchor for an hour, reporting every 3 minutes.
    for (let t = 0; t <= HOUR_MS; t += 180_000)
      h.check(pos(m, 5), 'a', undefined, T0 + t)
    // 20 nm away three minutes later is 400 kn.
    const s = h.check(pos(m, 25), 'a', undefined, T0 + HOUR_MS + 180_000)
    expect(s.speed?.implausible).toBe(true)
    expect(s.speed!.gapS).toBeLessThanOrEqual(
      (ANCHOR_MAX_AGE_MS + 180_000) / 1000,
    )
  })

  it('does not track messages without a position or other types', () => {
    const h = health()
    expect(h.check({ type: 1, mmsi: '999000024' }, 'a', 0, T0).speed).toBe(
      undefined,
    )
    h.check(pos('999000025', 5, 90, 4), 'a', undefined, T0)
    expect(
      h.check(pos('999000025', 50, 90, 4), 'a', undefined, T0 + 5000).speed,
    ).toBeUndefined()
  })

  it('changes limits without a restart', () => {
    const h = health()
    h.setLimits(limitsFromKnots(200, 200, 600))
    expect(jump(h, 1, 30)!.implausible).toBe(false)
  })
})

describe('Aggregator health counts', () => {
  it('counts invalid positions and reports without own position', () => {
    const agg = new Aggregator(T0)
    agg.add({ type: 1, mmsi: '999000030' }, OWN, T0)
    agg.add(pos('999000031', 5), undefined, T0)
    agg.add({ type: 5, mmsi: '999000032' }, undefined, T0)
    agg.add(pos('999000033', 5), OWN, T0)
    expect(agg.totals.health.positionInvalid).toBe(1)
    expect(agg.totals.health.noOwnPosition).toBe(1)
    // Still counted as messages and positions.
    expect(agg.totals.messages).toBe(4)
    expect(agg.totals.positions.A).toBe(3)
  })

  it('counts health events into the live buckets', () => {
    const agg = new Aggregator(T0)
    agg.countHealth('duplicates', T0 + 1000)
    agg.countHealth('decodeErrors', T0 + 2000, 3)
    agg.countHealth('decodeErrors', T0 + 3000, 0)
    expect(agg.totals.health.duplicates).toBe(1)
    expect(agg.lastHour(T0 + 5000).health.decodeErrors).toBe(3)
    expect(agg.hourBuckets(T0 + 5000).at(-1)!.health.duplicates).toBe(1)
  })
})
