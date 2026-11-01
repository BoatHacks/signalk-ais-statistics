import { describe, expect, it } from 'vitest'
import {
  classMix,
  duplicateHint,
  formatShare,
  goodShare,
  type Health,
} from '../../web/src/health'
import { makeUnit } from '../../web/src/units'

function health(received: number, counts: Partial<Health['counts']>): Health {
  return {
    received,
    counts: {
      decodeErrors: 0,
      incomplete: 0,
      duplicates: 0,
      duplicatesCrossEvent: 0,
      positionInvalid: 0,
      implausibleJumps: 0,
      noOwnPosition: 0,
      ...counts,
    },
  }
}

describe('message health in the web app', () => {
  it('counts faults of the message against the good share, not jumps', () => {
    const h = health(1000, {
      decodeErrors: 10,
      incomplete: 5,
      duplicates: 20,
      duplicatesCrossEvent: 15,
      positionInvalid: 50,
      implausibleJumps: 100,
      noOwnPosition: 300,
    })
    expect(goodShare(h)).toBeCloseTo(0.9)
    expect(goodShare(health(0, {}))).toBeNull()
  })

  it('hints above 20 percent duplicates of the decoded messages', () => {
    expect(duplicateHint(health(1000, { duplicates: 200 }))).toBe(false)
    expect(duplicateHint(health(1000, { duplicates: 201 }))).toBe(true)
    // Decode errors are not messages a duplicate could be a copy of.
    expect(
      duplicateHint(health(1000, { duplicates: 190, decodeErrors: 100 })),
    ).toBe(true)
    expect(duplicateHint(health(0, {}))).toBe(false)
  })

  it('counts cross-event duplicates only while per-source stats are off', () => {
    const h = health(1000, { duplicates: 100, duplicatesCrossEvent: 150 })
    expect(duplicateHint(h)).toBe(true)
    expect(duplicateHint(h, true)).toBe(false)
  })

  it('formats shares', () => {
    expect(formatShare(0.1234)).toBe('12.3 %')
    expect(formatShare(0.0004)).toBe('<0.1 %')
    expect(formatShare(0)).toBe('0.0 %')
    expect(formatShare(null)).toBe('–')
  })

  it('derives the class A and B mix per bucket', () => {
    expect(classMix([30, 0, null], [10, 0, 5])).toEqual({
      a: [0.75, null, 0],
      b: [0.25, null, 1],
    })
  })

  it('shows speeds in knots without a server preference', () => {
    const u = makeUnit('m/s', undefined)
    expect(u.format(1852 / 3600)).toBe('1 kn')
    expect(u.format(30.87)).toBe('60 kn')
    expect(u.formatDisplay(u.toDisplay(10))).toBe(u.format(10))
    const kmh = makeUnit('m/s', { formula: 'value * 3.6', symbol: 'km/h' })
    expect(kmh.format(10)).toBe('36 km/h')
  })
})
