import { describe, expect, it } from 'vitest'
import {
  Aggregator,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  sectorP99,
} from '../src/aggregate'
import { destination } from '../src/geo'
import { binOf, percentileNm } from '../src/histogram'
import type { AisMessage } from '../src/ingest'
import { OWN } from './fixtures/ais'

const T0 = Date.UTC(2030, 0, 1, 0, 0, 0)

function at(mmsi: string, bearing: number, nm: number, type = 1): AisMessage {
  const p = destination(OWN, bearing, nm)
  return { type, mmsi, lat: p.lat, lon: p.lon }
}

describe('Aggregator', () => {
  it('counts messages, positions by class and distance bins', () => {
    const agg = new Aggregator(T0)
    agg.add(at('999000001', 10, 5), OWN, T0)
    agg.add(at('999000002', 100, 12, 18), OWN, T0)
    agg.add(at('999000003', 200, 1.1, 9), OWN, T0)
    agg.add({ type: 5, mmsi: '999000001', shipType: 70 }, OWN, T0)
    agg.add({ type: 4, mmsi: '999000099' }, OWN, T0)
    const t = agg.totals
    expect(t.messages).toBe(5)
    expect(t.positions).toEqual({ A: 1, B: 1, other: 1 })
    expect(t.distanceBins[binOf(5)]).toBe(1)
    expect(t.distanceBins[binOf(12)]).toBe(1)
    expect(t.distanceBins[binOf(1.1)]).toBe(1)
  })

  it('counts sectors per class; other positions have no sector', () => {
    const agg = new Aggregator(T0)
    agg.add(at('999000001', 10, 5), OWN, T0)
    agg.add(at('999000002', 100, 5, 18), OWN, T0)
    agg.add(at('999000003', 100, 5, 9), OWN, T0)
    expect(agg.totals.sectorCounts[0]![0]).toBe(1)
    expect(agg.totals.sectorCounts[1]![6]).toBe(1)
    const sum = agg.totals.sectorCounts.flat().reduce((a, b) => a + b, 0)
    expect(sum).toBe(2)
  })

  it('counts reports without own position toward rates only', () => {
    const agg = new Aggregator(T0)
    const located = agg.add(at('999000001', 10, 5), undefined, T0)
    expect(located).toBeUndefined()
    expect(agg.totals.positions.A).toBe(1)
    expect(agg.totals.distanceBins.reduce((a, b) => a + b)).toBe(0)
  })

  it('counts reports without a position toward rates only', () => {
    const agg = new Aggregator(T0)
    agg.add({ type: 1, mmsi: '999000001' }, OWN, T0)
    expect(agg.totals.positions.A).toBe(1)
    expect(agg.totals.distanceBins.reduce((a, b) => a + b)).toBe(0)
  })

  it('keeps bogus far positions in every statistic', () => {
    const agg = new Aggregator(T0)
    const located = agg.add(at('999000001', 45, 3000), OWN, T0)
    expect(located?.distanceNm).toBeCloseTo(3000, 3)
    expect(agg.totals.distanceBins[31]).toBe(1)
    expect(agg.lastHour(T0).maxNm).toBeCloseTo(3000, 3)
  })

  it('rolls minute buckets and drops them after an hour', () => {
    const agg = new Aggregator(T0)
    agg.add(at('999000001', 10, 5), OWN, T0)
    agg.add(at('999000001', 10, 50), OWN, T0 + 30 * MINUTE_MS)
    expect(agg.lastHour(T0 + 30 * MINUTE_MS).positions.A).toBe(2)
    const later = agg.lastHour(T0 + 61 * MINUTE_MS)
    expect(later.positions.A).toBe(1)
    expect(percentileNm(later.distanceBins, 0.5)).toBeGreaterThan(40)
    expect(agg.totals.positions.A).toBe(2)
  })

  it('keeps 24 closed hours plus the open one, with vessel counts', () => {
    const agg = new Aggregator(T0)
    agg.add({ type: 5, mmsi: '999000001', shipType: 70 }, OWN, T0)
    agg.add(at('999000001', 0, 5), OWN, T0)
    agg.add(at('999000002', 0, 5, 18), OWN, T0 + 10)
    let hours = agg.hourBuckets(T0 + HOUR_MS)
    expect(hours).toHaveLength(2)
    expect(hours[0]!.vessels).toBe(2)
    expect(hours[0]!.vesselsByGroup.cargo).toBe(1)
    expect(hours[0]!.vesselsByGroup.unknown).toBe(1)
    hours = agg.hourBuckets(T0 + 30 * HOUR_MS)
    expect(hours.length).toBeLessThanOrEqual(25)
    expect(hours.every((h) => h.start >= T0 + 30 * HOUR_MS - DAY_MS)).toBe(true)
  })

  it('counts unique vessels per window and type group', () => {
    const agg = new Aggregator(T0)
    agg.add(at('999000001', 0, 5), OWN, T0)
    agg.add(at('999000001', 0, 5), OWN, T0 + 1000)
    agg.add(
      { type: 24, mmsi: '999000002', shipType: 37 },
      OWN,
      T0 + 2 * HOUR_MS,
    )
    agg.add({ type: 4, mmsi: '999000099' }, OWN, T0 + 2 * HOUR_MS)
    const now = T0 + 2 * HOUR_MS
    expect(agg.uniqueVessels(now, HOUR_MS).total).toBe(1)
    const day = agg.uniqueVessels(now, DAY_MS)
    expect(day.total).toBe(2)
    expect(day.byGroup.pleasureCraft).toBe(1)
    expect(day.byGroup.unknown).toBe(1)
    expect(agg.uniqueVessels(now + DAY_MS + 1, DAY_MS).total).toBe(0)
  })

  it('learns the type group after the first position', () => {
    const agg = new Aggregator(T0)
    agg.add(at('999000001', 0, 5), OWN, T0)
    expect(agg.uniqueVessels(T0, HOUR_MS).byGroup.unknown).toBe(1)
    agg.add({ type: 5, mmsi: '999000001', shipType: 80 }, OWN, T0 + 1)
    expect(agg.uniqueVessels(T0 + 1, HOUR_MS).byGroup.tanker).toBe(1)
  })

  it('derives per-sector p99 from the coarse histogram', () => {
    const agg = new Aggregator(T0)
    for (let i = 0; i < 100; i++) agg.add(at(`9990001${i}`, 92, 20), OWN, T0)
    const p99 = sectorP99(agg.lastHour(T0))
    expect(p99[0]![6]).toBeGreaterThan(14)
    expect(p99[0]![6]).toBeLessThan(33)
    expect(p99[0]![0]).toBeUndefined()
    expect(p99[1]![6]).toBeUndefined()
  })
})

describe('Aggregator sector maxima and names', () => {
  it('keeps the farthest distance per sector and when it was received', () => {
    const agg = new Aggregator(T0)
    agg.add(at('999000001', 50, 10), OWN, T0 + 1000)
    agg.add(at('999000002', 52, 300), OWN, T0 + 2000)
    agg.add(at('999000003', 51, 20), OWN, T0 + 3000)
    const h = agg.lastHour(T0 + 4000)
    expect(h.sectorMaxNm[0]![3]).toBeCloseTo(300, 0)
    expect(h.sectorMaxAt[0]![3]).toBe(T0 + 2000)
    expect(h.sectorMaxNm[1]![3]).toBe(0)
  })

  it('remembers vessel names from static messages', () => {
    const agg = new Aggregator(T0)
    agg.add({ type: 5, mmsi: '999000004', name: 'SYNTHETIC' }, OWN, T0)
    agg.add(at('999000004', 10, 5), OWN, T0 + 1000)
    expect(agg.vessel('999000004').name).toBe('SYNTHETIC')
    expect(agg.vessel('999000005').name).toBeUndefined()
  })
})
