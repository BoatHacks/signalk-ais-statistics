import { describe, expect, it } from 'vitest'
import {
  beforeRetention,
  change,
  compareWindows,
  formatRatio,
  fromPicker,
  signed,
  toPicker,
  windowLabel,
} from '../../web/src/compare'

const H = 3_600_000
const D = 24 * H

describe('compare windows', () => {
  it('puts the hours before the change next to the hours from it on', () => {
    const now = Date.UTC(2030, 0, 20, 10, 30)
    const { before, after } = compareWindows(
      { at: Date.UTC(2030, 0, 8, 14), hours: 6 },
      now,
    )
    expect(before).toMatchObject({
      from: Date.UTC(2030, 0, 8, 8),
      to: Date.UTC(2030, 0, 8, 14),
      fromDay: '2030-01-08',
      toDay: '2030-01-08',
      hours: 6,
      wholeDays: false,
    })
    expect(after).toMatchObject({
      from: Date.UTC(2030, 0, 8, 14),
      to: Date.UTC(2030, 0, 8, 20),
      hours: 6,
      wholeDays: false,
    })
  })

  it('knows windows of whole UTC days, which have coverage', () => {
    const now = Date.UTC(2030, 0, 20, 10, 30)
    const { before, after } = compareWindows(
      { at: Date.UTC(2030, 0, 8), hours: 120 },
      now,
    )
    expect(before).toMatchObject({
      fromDay: '2030-01-03',
      toDay: '2030-01-07',
      wholeDays: true,
    })
    expect(after).toMatchObject({
      fromDay: '2030-01-08',
      toDay: '2030-01-12',
      wholeDays: true,
    })
    const offMidnight = compareWindows(
      { at: Date.UTC(2030, 0, 8, 1), hours: 24 },
      now,
    )
    expect(offMidnight.before.wholeDays).toBe(false)
    expect(offMidnight.after.wholeDays).toBe(false)
  })

  it('ends the after window at the next full hour', () => {
    const now = Date.UTC(2030, 0, 10, 10, 30)
    const { after } = compareWindows(
      { at: Date.UTC(2030, 0, 8), hours: 120 },
      now,
    )
    expect(after.to).toBe(Date.UTC(2030, 0, 10, 11))
    expect(after.toDay).toBe('2030-01-10')
    expect(after.hours).toBe(2 * 24 + 11)
    // Today's coverage is kept up to now, so this still counts as days.
    expect(after.wholeDays).toBe(true)
    // On the hour itself, the window still holds the hour that starts now.
    const onHour = compareWindows(
      { at: Date.UTC(2030, 0, 10), hours: 24 },
      Date.UTC(2030, 0, 10),
    ).after
    expect(onHour.to - onHour.from).toBe(H)
  })

  it('says when a window starts before the oldest kept coverage day', () => {
    const { before } = compareWindows(
      { at: Date.UTC(2030, 0, 8), hours: 120 },
      Date.UTC(2030, 0, 14) + D,
    )
    expect(beforeRetention(before, '2030-01-04')).toBe(true)
    expect(beforeRetention(before, '2030-01-03')).toBe(false)
  })

  it('reads and writes the picker in ship time, on the full hour', () => {
    const t = Date.UTC(2030, 0, 8, 14)
    expect(toPicker(t, undefined)).toBe('2030-01-08T14:00')
    expect(toPicker(t, 120)).toBe('2030-01-08T16:00')
    expect(fromPicker('2030-01-08T16:00', 120)).toBe(t)
    expect(fromPicker('2030-01-08T14:45', undefined)).toBe(t)
    expect(fromPicker('2030-01-08T09:00', -300)).toBe(t)
    expect(fromPicker('', undefined)).toBeUndefined()
    expect(fromPicker('2030-01-08', undefined)).toBeUndefined()
  })

  it('labels a window with its start and end', () => {
    const w = compareWindows(
      { at: Date.UTC(2030, 0, 8, 14), hours: 6 },
      Date.UTC(2030, 1, 1),
    )
    expect(windowLabel(w.after, undefined)).toBe('2030-01-08 14:00Z to 20:00Z')
    expect(windowLabel(w.after, 300)).toBe(
      '2030-01-08 19:00 to 2030-01-09 01:00',
    )
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
