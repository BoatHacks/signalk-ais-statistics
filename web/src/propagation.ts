// Propagation alert texts and the trial of alert settings (SPEC 2.10, 7).
// No DOM here, so the tests can run it as is.
import {
  conditionsMet,
  replay,
  type Check,
  type Rule,
} from '../../src/propagation'

export type PropagationState = 'unarmed' | 'normal' | 'alert' | 'suppressed'

/** What GET /propagation answers. */
export type Propagation =
  | { enabled: false }
  | {
      enabled: true
      state: PropagationState
      ratio: number | null
      p99M: number | null
      baselineM: number | null
      baselineHours: number
      vessels: number
      sectors: string[]
      since: string | null
      mode: 'stationary' | 'underway' | 'unknown'
      rule: Rule & { windowMinutes: number }
      checks: {
        time: string
        armed: boolean
        ratio: number | null
        vessels: number
      }[]
    }

/** The live notification, as the WebSocket delivers it. */
export interface AlertNotification {
  state?: string
  message?: string
}

/** The banner text while an alert is active, or undefined to hide it. */
export function bannerText(
  n: AlertNotification | undefined,
): string | undefined {
  if (!n || !n.state || n.state === 'normal') return undefined
  return n.message || 'AIS reception range is well above normal.'
}

/** One line on the state, distances already formatted by the caller. */
export function stateText(
  p: Extract<Propagation, { enabled: true }>,
  fmt: (m: number) => string,
  formatTime: (t: number) => string,
): string {
  const ratio = p.ratio === null ? null : `${p.ratio.toFixed(1)} times`
  switch (p.state) {
    case 'unarmed':
      return `Learning the normal range: ${p.baselineHours} of 24 hours with at least 20 reports known. Alerts start after that.`
    case 'alert':
      return `Alert since ${p.since ? formatTime(Date.parse(p.since)) : 'now'}: range ${ratio ?? 'well above'} normal.`
    case 'suppressed':
      return `Range ${ratio ?? 'well above'} normal, but the vessel is underway, so no alert is raised.`
    case 'normal':
      return p.baselineM === null
        ? 'No alert.'
        : `No alert. Normal p99 ${fmt(p.baselineM)}${ratio ? `, now ${ratio} that` : ''}.`
  }
}

const checks = (p: Extract<Propagation, { enabled: true }>): Check[] =>
  p.checks.map((c) => ({ ...c, time: Date.parse(c.time) }))

/**
 * What the given settings would have done over the last hour of checks:
 * whether an alert would be active now, and for how many of those minutes
 * the conditions held.
 */
export function trial(
  p: Extract<Propagation, { enabled: true }>,
  rule: Rule,
): { active: boolean; metMinutes: number; minutes: number } {
  const list = checks(p)
  const s = replay(list, rule)
  const met = list.filter((c) => conditionsMet(c, rule)).length
  return { active: s.active, metMinutes: met, minutes: list.length }
}

export function trialText(t: ReturnType<typeof trial>): string {
  if (t.minutes === 0)
    return 'No checks yet; the first runs a minute after the start.'
  return `With these settings, over the last ${t.minutes} minutes the conditions held for ${t.metMinutes}, and an alert ${t.active ? 'would be active now' : 'would not be active now'}.`
}
