import { describe, expect, it } from 'vitest'
import {
  beforeRetention,
  change,
  compareWindows,
  formatRatio,
  signed,
} from '../../web/src/compare'

const H = 3_600_000
const D = 24 * H

describe('compare windows', () => {
  it('puts the days before the date next to the days from it on', () => {
    const now = Date.UTC(2030, 0, 20, 10, 30)
    const { before, after } = compareWindows(
      { date: '2030-01-08', days: 7 },
      now,
    )
    expect(before.from).toBe(Date.UTC(2030, 0, 1))
    expect(before.to).toBe(Date.UTC(2030, 0, 8))
    expect(before).toMatchObject({
      fromDay: '2030-01-01',
      toDay: '2030-01-07',
      hours: 168,
    })
    expect(after).toMatchObject({
      from: Date.UTC(2030, 0, 8),
      to: Date.UTC(2030, 0, 15),
      fromDay: '2030-01-08',
      toDay: '2030-01-14',
      hours: 168,
    })
  })

  it('ends the after window at the next full hour', () => {
    const now = Date.UTC(2030, 0, 10, 10, 30)
    const { after } = compareWindows({ date: '2030-01-08', days: 7 }, now)
    expect(after.to).toBe(Date.UTC(2030, 0, 10, 11))
    expect(after.toDay).toBe('2030-01-10')
    expect(after.hours).toBe(2 * 24 + 11)
    // On the hour itself, the window still holds the hour that starts now.
    const onHour = compareWindows(
      { date: '2030-01-10', days: 1 },
      Date.UTC(2030, 0, 10),
    ).after
    expect(onHour.to - onHour.from).toBe(H)
  })

  it('says when a window starts before the oldest kept coverage day', () => {
    const { before } = compareWindows(
      { date: '2030-01-08', days: 7 },
      Date.UTC(2030, 0, 14) + D,
    )
    expect(beforeRetention(before, '2030-01-02')).toBe(true)
    expect(beforeRetention(before, '2030-01-01')).toBe(false)
  })
})

describe('compare changes', () => {
  it('compares counts per hour when the after window is shorter', () => {
    expect(change(100, 50, { before: 168, after: 84 })).toEqual({
      delta: 0,
      ratio: 0,
    })
    expect(change(100, 150, { before: 10, after: 10 })).toEqual({
      delta: 50,
      ratio: 0.5,
    })
  })

  it('compares distances as they are, and has no ratio without a base', () => {
    expect(change(1000, 800)).toEqual({ delta: -200, ratio: -0.2 })
    expect(change(0, 5)).toEqual({ delta: 5, ratio: null })
    expect(change(null, 5)).toBeNull()
    expect(change(5, null)).toBeNull()
  })

  it('formats signed changes', () => {
    expect(formatRatio(0.123)).toBe('+12 %')
    expect(formatRatio(-0.05)).toBe('-5 %')
    expect(formatRatio(0)).toBe('0 %')
    expect(formatRatio(null)).toBe('–')
    const f = (v: number) => `${v} m`
    expect(signed(5, f)).toBe('+5 m')
    expect(signed(-5, f)).toBe('-5 m')
    expect(signed(0, f)).toBe('0 m')
  })
})
