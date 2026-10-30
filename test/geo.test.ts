import { describe, expect, it } from 'vitest'
import { bearingDeg, destination, distanceNm, sectorOf } from '../src/geo'

describe('geo', () => {
  it('measures one minute of latitude as about one nautical mile', () => {
    expect(distanceNm({ lat: 0, lon: 0 }, { lat: 1 / 60, lon: 0 })).toBeCloseTo(
      1,
      2,
    )
  })

  it('gives cardinal bearings', () => {
    const o = { lat: 0, lon: 0 }
    expect(bearingDeg(o, { lat: 1, lon: 0 })).toBeCloseTo(0)
    expect(bearingDeg(o, { lat: 0, lon: 1 })).toBeCloseTo(90)
    expect(bearingDeg(o, { lat: -1, lon: 0 })).toBeCloseTo(180)
    expect(bearingDeg(o, { lat: 0, lon: -1 })).toBeCloseTo(270)
  })

  it('round-trips destination with distance and bearing', () => {
    const o = { lat: 0.5, lon: -0.5 }
    const d = destination(o, 123, 42)
    expect(distanceNm(o, d)).toBeCloseTo(42, 6)
    expect(bearingDeg(o, d)).toBeCloseTo(123, 6)
  })

  it('maps bearings to 15 degree sectors', () => {
    expect(sectorOf(0)).toBe(0)
    expect(sectorOf(14.99)).toBe(0)
    expect(sectorOf(15)).toBe(1)
    expect(sectorOf(359.99)).toBe(23)
    expect(sectorOf(360)).toBe(0)
    expect(sectorOf(-1)).toBe(23)
  })
})
