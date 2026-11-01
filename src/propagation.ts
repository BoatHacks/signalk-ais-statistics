// Propagation alerts (SPEC 2.10, ARCHITECTURE 2.4c): a side view of the
// located reports that compares the recent p99 distance with the normal
// one and raises an alert while range stays well above normal. Pure and
// clock-injectable; the plugin feeds it reports, checks it once a minute
// and publishes what it says. Nothing here removes a report from any other
// statistic (SPEC 2.3).
import { M_PER_NM, sectorOf } from './geo'
import type { Mode } from './mode'
import { addInto, emptyBins, summarize } from './histogram'
import { sectorLabel } from './paths'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

/**
 * `unarmed`: fewer than MIN_BASELINE_HOURS normal hours are known.
 * `suppressed`: the alert holds but the vessel is underway and the
 * setting keeps it quiet then.
 */
export type PropagationState = 'unarmed' | 'normal' | 'alert' | 'suppressed'

/** Qualifying hours the normal range needs before alerts can fire. */
export const MIN_BASELINE_HOURS = 24
/**
 * Reports an hour needs to count toward the normal range. A sparse hour's
 * p99 lands on a bin edge, as for the sectors (SPEC 2.6).
 */
export const MIN_HOUR_REPORTS = 20
/** Checks kept for the status route and the web app's trial settings. */
export const CHECKS_KEPT = 60
/** Upper bound on senders tracked in the recent window; oldest go first. */
export const MAX_SENDERS = 5000

/** The three settings the web app can try live (SPEC 9.1). */
export interface Rule {
  factor: number
  minVessels: number
  sustainMinutes: number
}

/** One evaluation of the conditions, once a minute. */
export interface Check {
  time: number
  /** Whether enough normal hours are known for the check to count. */
  armed: boolean
  /** Recent p99 over the normal p99; null without either. */
  ratio: number | null
  /** Distinct senders received beyond the normal p99 in the window. */
  vessels: number
}

export interface RuleState {
  active: boolean
  /** When the alert became active. */
  since?: number
  /** First check of the current run of checks that met the conditions. */
  metSince?: number
  /** First check of the current run that did not. */
  unmetSince?: number
}

export function conditionsMet(c: Check, r: Rule): boolean {
  return (
    c.armed &&
    c.ratio !== null &&
    c.ratio >= r.factor &&
    c.vessels >= r.minVessels
  )
}

/**
 * Advances the rule by one check. The alert fires once the conditions have
 * held at every check for the sustain time and clears once they have
 * failed at every check for the same time (chosen by the maintainer).
 */
export function step(s: RuleState, c: Check, r: Rule): RuleState {
  const sustainMs = r.sustainMinutes * MINUTE_MS
  const next: RuleState = { ...s }
  if (conditionsMet(c, r)) {
    next.unmetSince = undefined
    next.metSince ??= c.time
    if (!next.active && c.time - next.metSince >= sustainMs) {
      next.active = true
      next.since = c.time
    }
  } else {
    next.metSince = undefined
    next.unmetSince ??= c.time
    if (next.active && c.time - next.unmetSince >= sustainMs) {
      next.active = false
      next.since = undefined
    }
  }
  return next
}

/**
 * The rule replayed over checks, oldest first, from no alert. The web app
 * uses it to show what trial settings would have done.
 */
export function replay(checks: readonly Check[], r: Rule): RuleState {
  let s: RuleState = { active: false }
  for (const c of checks) s = step(s, c, r)
  return s
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const v = [...values].sort((a, b) => a - b)
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1]! + v[mid]!) / 2
}

/** The normal range: median hourly p99 over the last 7 days. */
export interface Baseline {
  nm: number
  /** Hours it was taken from. */
  hours: number
}

/** The columns of an hourly distance series that the baseline reads. */
export interface HourlyDistance {
  times: string[]
  count?: unknown
  p99M?: unknown
  maxM?: unknown
}

const column = (v: unknown): (number | null)[] =>
  Array.isArray(v) ? (v as (number | null)[]) : []

/**
 * The baseline from an hourly distance series: hours that have ended,
 * with at least MIN_HOUR_REPORTS reports, each p99 capped at the hour's
 * farthest reception where known. Undefined without such an hour.
 */
export function baselineFrom(
  series: HourlyDistance,
  now: number,
): Baseline | undefined {
  const count = column(series.count)
  const p99 = column(series.p99M)
  const max = column(series.maxM)
  const values: number[] = []
  series.times.forEach((t, i) => {
    const start = Date.parse(t)
    if (!(start + HOUR_MS <= now)) return
    const n = count[i]
    const p = p99[i]
    if (typeof n !== 'number' || n < MIN_HOUR_REPORTS) return
    if (typeof p !== 'number' || !(p > 0)) return
    const m = max[i]
    values.push(typeof m === 'number' && m > 0 ? Math.min(p, m) : p)
  })
  const mid = median(values)
  return mid === undefined
    ? undefined
    : { nm: mid / M_PER_NM, hours: values.length }
}

/** What the window needs of an aggregator minute bucket. */
export interface MinuteBucket {
  start: number
  distanceBins: readonly number[]
  maxNm?: number
}

/** The recent p99 from the live minute buckets in the window. */
export function windowP99Nm(
  minutes: readonly MinuteBucket[],
  time: number,
  windowMs: number,
): number | undefined {
  const bins = emptyBins()
  let maxNm: number | undefined
  for (const b of minutes) {
    if (b.start + MINUTE_MS <= time - windowMs || b.start > time) continue
    addInto(bins, b.distanceBins)
    if (b.maxNm !== undefined && (maxNm === undefined || b.maxNm > maxNm))
      maxNm = b.maxNm
  }
  return summarize(bins, maxNm).p99Nm
}

interface Far {
  minute: number
  nm: number
  bearingDeg: number
}

export interface DetectorSettings extends Rule {
  windowMinutes: number
}

/** A report with a distance, as the aggregator locates it. */
export interface Report {
  mmsi: string
  distanceNm: number
  bearingDeg: number
  time: number
}

export interface PropagationStatus {
  state: PropagationState
  ratio: number | null
  p99M: number | null
  baselineM: number | null
  baselineHours: number
  vessels: number
  /** Sectors (starting bearings) of the senders beyond normal. */
  sectors: string[]
  since: string | null
  mode: Mode
  rule: DetectorSettings
  /** The last CHECKS_KEPT checks, oldest first. */
  checks: {
    time: string
    armed: boolean
    ratio: number | null
    vessels: number
  }[]
}

export class PropagationDetector {
  /** Per sender, the farthest report of each minute in the window. */
  private far = new Map<string, Far[]>()
  private checks: Check[] = []
  private rule: RuleState = { active: false }
  private baseline?: Baseline
  private lastP99Nm?: number

  constructor(private settings: DetectorSettings) {}

  setRule(r: Rule): void {
    this.settings = { ...this.settings, ...r }
  }

  setBaseline(b: Baseline | undefined): void {
    this.baseline = b
  }

  armed(): boolean {
    return (this.baseline?.hours ?? 0) >= MIN_BASELINE_HOURS
  }

  private windowMs(): number {
    return this.settings.windowMinutes * MINUTE_MS
  }

  /** Records a located report. */
  see(r: Report): void {
    const minute = Math.floor(r.time / MINUTE_MS) * MINUTE_MS
    let list = this.far.get(r.mmsi)
    if (list) this.far.delete(r.mmsi)
    else {
      list = []
      if (this.far.size >= MAX_SENDERS) {
        const oldest = this.far.keys().next()
        if (!oldest.done) this.far.delete(oldest.value)
      }
    }
    // Re-inserted, so the map stays ordered by last report.
    this.far.set(r.mmsi, list)
    const last = list[list.length - 1]
    if (last && last.minute === minute) {
      if (r.distanceNm > last.nm) {
        last.nm = r.distanceNm
        last.bearingDeg = r.bearingDeg
      }
    } else list.push({ minute, nm: r.distanceNm, bearingDeg: r.bearingDeg })
  }

  private prune(time: number): void {
    const from = time - this.windowMs()
    for (const [mmsi, list] of this.far) {
      while (list.length && list[0]!.minute + MINUTE_MS <= from) list.shift()
      if (list.length === 0) this.far.delete(mmsi)
    }
  }

  /** Senders beyond the normal range in the window, with their sectors. */
  private beyond(): { vessels: number; sectors: number[] } {
    const limit = this.baseline?.nm
    if (limit === undefined) return { vessels: 0, sectors: [] }
    const sectors = new Set<number>()
    let vessels = 0
    for (const list of this.far.values()) {
      let best: Far | undefined
      for (const f of list) if (!best || f.nm > best.nm) best = f
      if (best && best.nm > limit) {
        vessels++
        sectors.add(sectorOf(best.bearingDeg))
      }
    }
    return { vessels, sectors: [...sectors].sort((a, b) => a - b) }
  }

  /**
   * Evaluates the conditions at `time` from the live minute buckets and
   * advances the rule. Call once a minute.
   */
  check(time: number, minutes: readonly MinuteBucket[]): Check {
    this.prune(time)
    const p99 = windowP99Nm(minutes, time, this.windowMs())
    this.lastP99Nm = p99
    const base = this.baseline?.nm
    const c: Check = {
      time,
      armed: this.armed(),
      ratio:
        p99 === undefined || base === undefined || !(base > 0)
          ? null
          : p99 / base,
      vessels: this.beyond().vessels,
    }
    this.rule = step(this.rule, c, this.settings)
    this.checks.push(c)
    if (this.checks.length > CHECKS_KEPT) this.checks.shift()
    return c
  }

  /** The ratio of the last check, for the gauge path. */
  ratio(): number | null {
    return this.checks[this.checks.length - 1]?.ratio ?? null
  }

  state(mode: Mode, suppressUnderway: boolean): PropagationState {
    if (this.rule.active)
      return suppressUnderway && mode === 'underway' ? 'suppressed' : 'alert'
    return this.armed() ? 'normal' : 'unarmed'
  }

  status(mode: Mode, suppressUnderway: boolean): PropagationStatus {
    const m = (nm: number | undefined) =>
      nm === undefined ? null : Math.round(nm * M_PER_NM)
    const far = this.beyond()
    return {
      state: this.state(mode, suppressUnderway),
      ratio: this.ratio(),
      p99M: m(this.lastP99Nm),
      baselineM: m(this.baseline?.nm),
      baselineHours: this.baseline?.hours ?? 0,
      vessels: far.vessels,
      sectors: far.sectors.map(sectorLabel),
      since:
        this.rule.active && this.rule.since !== undefined
          ? new Date(this.rule.since).toISOString()
          : null,
      mode,
      rule: { ...this.settings },
      checks: this.checks.map((c) => ({
        time: new Date(c.time).toISOString(),
        armed: c.armed,
        ratio: c.ratio,
        vessels: c.vessels,
      })),
    }
  }
}

/** The notification message for an active alert, distances in nm. */
export function alertMessage(s: PropagationStatus): string {
  const nm = (m: number | null) =>
    m === null ? '?' : `${Math.round(m / M_PER_NM)} nm`
  const ratio = s.ratio === null ? '?' : s.ratio.toFixed(1)
  const from = s.sectors.length ? `, from sectors ${s.sectors.join(', ')}` : ''
  return `AIS range ${ratio} times normal: p99 ${nm(s.p99M)} against ${nm(s.baselineM)}, ${s.vessels} vessels beyond normal${from}`
}

/** The notification value: the alert, or `normal` once it ends. */
export function notificationValue(
  active: boolean,
  state: string,
  methods: string[],
  message: string,
): { state: string; method: string[]; message: string } {
  return active
    ? { state, method: [...methods], message }
    : { state: 'normal', method: [], message }
}
