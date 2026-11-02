// Compare view helpers (SPEC 7): the two hour windows around a change and
// the difference between them. Kept free of the DOM so they can be tested.
import type { CompareParams } from './route'
import { formatDate, formatDateTime, formatTime } from './time'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10)

export interface CompareWindow {
  /** Whole hours, as the REST API wants them. */
  from: number
  to: number
  /** First and last UTC day, both included, for the coverage route. */
  fromDay: string
  toDay: string
  hours: number
  /** True when the window is whole UTC days, the unit coverage is kept in. */
  wholeDays: boolean
}

function window(from: number, to: number): CompareWindow {
  return {
    from,
    to,
    fromDay: utcDay(from),
    toDay: utcDay(to - 1),
    hours: Math.round((to - from) / HOUR_MS),
    wholeDays: from % DAY_MS === 0 && to % DAY_MS === 0,
  }
}

/**
 * The `hours` before the change and the `hours` from it on. The after
 * window ends at the next full hour at the latest, so a change close to
 * now gives a shorter after window. Its `wholeDays` follows the full
 * length, since today's coverage is kept up to now.
 */
export function compareWindows(
  c: Pick<CompareParams, 'at' | 'hours'>,
  now: number,
): { before: CompareWindow; after: CompareWindow } {
  const length = c.hours * HOUR_MS
  const nextHour = Math.ceil((now + 1) / HOUR_MS) * HOUR_MS
  const after = window(c.at, Math.min(c.at + length, nextHour))
  return {
    before: window(c.at - length, c.at),
    after: {
      ...after,
      wholeDays: c.at % DAY_MS === 0 && length % DAY_MS === 0,
    },
  }
}

/**
 * The value of a datetime-local input for a time, in ship time when the
 * offset is known and in UTC otherwise, as all times in the app are.
 */
export function toPicker(t: number, offsetMin: number | undefined): string {
  return new Date(t + (offsetMin ?? 0) * MINUTE_MS).toISOString().slice(0, 16)
}

/**
 * The full UTC hour a datetime-local value falls in; minutes are dropped
 * because history is kept per hour. Undefined for an empty or bad value.
 */
export function fromPicker(
  v: string,
  offsetMin: number | undefined,
): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v))
    return undefined
  const t = Date.parse(`${v}Z`)
  if (!Number.isFinite(t)) return undefined
  return Math.floor((t - (offsetMin ?? 0) * MINUTE_MS) / HOUR_MS) * HOUR_MS
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

/**
 * "2030-01-08 14:00 to 20:00", or with the end date when the window ends
 * on another day. The end is exclusive: a 24 hour window from 14:00 ends
 * at 14:00 the next day.
 */
export function windowLabel(
  w: CompareWindow,
  offsetMin: number | undefined,
): string {
  const end =
    formatDate(w.from, offsetMin) === formatDate(w.to, offsetMin)
      ? formatTime(w.to, offsetMin)
      : formatDateTime(w.to, offsetMin)
  return `${formatDateTime(w.from, offsetMin)} to ${end}`
}
