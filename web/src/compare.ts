// Compare view helpers (SPEC 7): the two date windows and the change
// between them. Kept free of the DOM so they can be tested.
import type { CompareParams } from './route'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10)

export interface CompareWindow {
  /** Whole hours, as the REST API wants them. */
  from: number
  to: number
  /** First and last UTC day, both included, for the coverage route. */
  fromDay: string
  toDay: string
  hours: number
}

function window(from: number, to: number): CompareWindow {
  return {
    from,
    to,
    fromDay: utcDay(from),
    toDay: utcDay(to - 1),
    hours: Math.round((to - from) / HOUR_MS),
  }
}

/**
 * The window of `days` before the date and the one from the date on. The
 * after window ends at the next full hour at the latest, so a date close
 * to today gives a shorter after window.
 */
export function compareWindows(
  c: Pick<CompareParams, 'date' | 'days'>,
  now: number,
): { before: CompareWindow; after: CompareWindow } {
  const start = Date.parse(c.date)
  const length = c.days * DAY_MS
  const nextHour = Math.ceil((now + 1) / HOUR_MS) * HOUR_MS
  return {
    before: window(start - length, start),
    after: window(start, Math.min(start + length, nextHour)),
  }
}

export interface Change {
  /** After minus before, after scaling the after value to equal length. */
  delta: number
  /** Relative to before; null when before is zero. */
  ratio: number | null
}

/**
 * The change from `before` to `after`. Counts (`perHour`) are compared as
 * rates when the windows differ in length; distances and areas are not.
 */
export function change(
  before: number | null,
  after: number | null,
  hours?: { before: number; after: number },
): Change | null {
  if (before === null || after === null) return null
  let a = after
  if (hours && hours.after > 0 && hours.after !== hours.before)
    a = (after * hours.before) / hours.after
  const delta = a - before
  return { delta, ratio: before === 0 ? null : delta / before }
}

/** "+12 %", "-5 %" or "0 %"; a dash without a base. */
export function formatRatio(r: number | null): string {
  if (r === null) return '–'
  const p = Math.round(r * 100)
  return `${p > 0 ? '+' : ''}${p} %`
}

/** A signed difference in display units, "+1.2 nm" or "-300". */
export function signed(delta: number, format: (v: number) => string): string {
  if (Math.abs(delta) < 1e-9) return format(0)
  return delta > 0 ? `+${format(delta)}` : `-${format(-delta)}`
}

/** True when a window starts before the oldest kept coverage day. */
export function beforeRetention(
  w: CompareWindow,
  retainedFrom: string,
): boolean {
  return w.fromDay < retainedFrom
}
