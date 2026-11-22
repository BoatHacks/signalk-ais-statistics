import { describe, expect, it } from 'vitest'
import {
  bearingDeg,
  destination,
  distanceNm,
  sectorOf,
  zeroLatitudeGlitch,
} from '../src/geo'

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

  describe('zeroLatitudeGlitch', () => {
    const north = { lat: 40, lon: -30 }
    const south = { lat: -40, lon: -30 }

    it('takes latitude 0 and -0 heard far from the equator for a glitch', () => {
      for (const own of [north, south]) {
        expect(zeroLatitudeGlitch(0, own)).toBe(true)
        expect(zeroLatitudeGlitch(-0, own)).toBe(true)
      }
      expect(zeroLatitudeGlitch(0, { lat: 5, lon: 0 })).toBe(true)
      expect(zeroLatitudeGlitch(0, { lat: -5, lon: 0 })).toBe(true)
    })

    it('keeps latitude 0 heard near the equator', () => {
      expect(zeroLatitudeGlitch(0, { lat: 0, lon: 0 })).toBe(false)
      expect(zeroLatitudeGlitch(0, { lat: 4.99, lon: 0 })).toBe(false)
      expect(zeroLatitudeGlitch(0, { lat: -4.99, lon: 0 })).toBe(false)
    })

    it('judges only latitude exactly 0, and only with an own position', () => {
      expect(zeroLatitudeGlitch(0.0001, north)).toBe(false)
      expect(zeroLatitudeGlitch(40, north)).toBe(false)
      expect(zeroLatitudeGlitch(undefined, north)).toBe(false)
      expect(zeroLatitudeGlitch(0, undefined)).toBe(false)
    })
  })
})
