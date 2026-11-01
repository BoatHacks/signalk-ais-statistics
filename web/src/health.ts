// Message health in the web app (SPEC 2.8, 7): shares of the received
// messages and the duplicate hint. Pure, so it is tested without a DOM.

export const HEALTH_KINDS = [
  'decodeErrors',
  'incomplete',
  'duplicates',
  'duplicatesCrossEvent',
  'positionInvalid',
  'implausibleJumps',
  'noOwnPosition',
] as const
export type HealthKind = (typeof HEALTH_KINDS)[number]

export interface Health {
  /** Everything received: decoded messages, decode errors and incomplete. */
  received: number
  counts: Record<HealthKind, number>
}

/** Above this share of duplicates the overview shows the hint (fixed). */
export const DUPLICATE_HINT_SHARE = 0.2

/** The faults that make a received message unusable or redundant. */
const FAULTS: HealthKind[] = [
  'decodeErrors',
  'incomplete',
  'duplicates',
  'duplicatesCrossEvent',
  'positionInvalid',
]

export function share(n: number, total: number): number | null {
  return total > 0 ? n / total : null
}

/**
 * Share of received messages without a fault: decodable, complete, not a
 * copy and, for position reports, with a usable position. Jumps and
 * reports without an own position are no fault of the message.
 */
export function goodShare(h: Health): number | null {
  let bad = 0
  for (const k of FAULTS) bad += h.counts[k]
  return share(Math.max(0, h.received - bad), h.received)
}

/**
 * Whether duplicates make up more than 20 percent of the decoded messages.
 * Same-event duplicates always count. Cross-event ones count too while
 * per-source statistics are off, since one receiver on two events is then
 * the likely cause; with them on they are shown as receiver overlap.
 */
export function duplicateHint(h: Health, perSourceStats = false): boolean {
  const decoded = h.received - h.counts.decodeErrors - h.counts.incomplete
  const dup =
    h.counts.duplicates + (perSourceStats ? 0 : h.counts.duplicatesCrossEvent)
  const s = share(dup, decoded)
  return s !== null && s > DUPLICATE_HINT_SHARE
}

/** A share as a percentage with one decimal, or a dash without data. */
export function formatShare(s: number | null): string {
  if (s === null) return '–'
  const p = s * 100
  if (p > 0 && p < 0.1) return '<0.1 %'
  return `${p.toFixed(1)} %`
}

/** Class A and B shares of the class A and B position reports per bucket. */
export function classMix(
  a: (number | null)[],
  b: (number | null)[],
): { a: (number | null)[]; b: (number | null)[] } {
  const out = { a: [] as (number | null)[], b: [] as (number | null)[] }
  a.forEach((x, i) => {
    const na = x ?? 0
    const nb = b[i] ?? 0
    const t = na + nb
    out.a.push(t > 0 ? na / t : null)
    out.b.push(t > 0 ? nb / t : null)
  })
  return out
}
