import { describe, expect, it } from 'vitest'
import {
  formatDate,
  formatDateTime,
  formatTime,
  parseOffset,
} from '../../web/src/time'

const T = Date.UTC(2030, 0, 1, 23, 45, 10)

describe('parseOffset', () => {
  it('reads the (-)hhmm encoding into minutes', () => {
    expect(parseOffset(200)).toBe(120)
    expect(parseOffset(-930)).toBe(-570)
    expect(parseOffset(0)).toBe(0)
    expect(parseOffset('x')).toBeUndefined()
    expect(parseOffset(null)).toBeUndefined()
  })
})

describe('ship time', () => {
  it('shows local ship time without a zone when the offset is known', () => {
    expect(formatTime(T, 120)).toBe('01:45')
    expect(formatDate(T, 120)).toBe('2030-01-02')
    expect(formatDateTime(T, -570)).toBe('2030-01-01 14:15')
  })

  it('shows UTC with Z otherwise', () => {
    expect(formatTime(T, undefined)).toBe('23:45Z')
    expect(formatDate(T, undefined)).toBe('2030-01-01')
    expect(formatDateTime(T, undefined)).toBe('2030-01-01 23:45Z')
  })
})
