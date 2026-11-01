import { describe, expect, it } from 'vitest'
import { maxTime } from '../../web/src/time'
import { formatPosition } from '../../web/src/units'

describe('farthest reception text', () => {
  it('gives the exact time, or the hour it falls in', () => {
    expect(maxTime({ maxAt: '2030-01-01T12:34:56Z', maxHour: null }, 60)).toBe(
      '2030-01-01 13:34',
    )
    expect(
      maxTime({ maxAt: null, maxHour: '2030-01-01T11:00:00Z' }, undefined),
    ).toBe('between 2030-01-01 11:00Z and 12:00Z')
    expect(maxTime({ maxAt: null, maxHour: null }, undefined)).toBe(
      'time unknown',
    )
  })

  it('formats positions with hemispheres', () => {
    expect(formatPosition(-1.23456, 2.5)).toBe('1.235° S, 2.500° E')
    expect(formatPosition(0.1, -0.2)).toBe('0.100° N, 0.200° W')
  })
})
