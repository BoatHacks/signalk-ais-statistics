// Own vessel mode, stationary or underway (ARCHITECTURE 2.2, SPEC 2.8).
// Pure state: values and positions come in with their times, nothing reads
// a clock or does I/O.
//
// `navigation.state` decides whenever its last value is recognised, even if
// the crew forgot to change it (SPEC 12). Otherwise the drift of the own
// position decides: stationary while every position of the last
// `windowMs` lies within `radiusM` of their mean.
import { distanceNm, M_PER_NM } from './geo'
import type { LatLon } from './ownposition'

export const MODES = ['stationary', 'underway', 'unknown'] as const
export type Mode = (typeof MODES)[number]
/** What decided the mode, or null while it is unknown. */
export type ModeSource = 'state' | 'drift' | null

/** At most this many drift samples are held, whatever the window. */
export const MAX_DRIFT_SAMPLES = 60
/** Drift samples are at least this far apart. */
const MIN_SAMPLE_MS = 10_000

/** `navigation.state` values meaning the vessel is not moving. */
const STATIONARY_STATES = new Set([
  'anchored',
  'moored',
  'not under way',
  'aground',
])
/**
 * `navigation.state` values (or their start) meaning the vessel moves. The
 * schema enum spells "manouverability"; both spellings are matched, as the
 * enum may be corrected upstream.
 */
const UNDERWAY_STATES = [
  'sailing',
  'motoring',
  'towing',
  'pushing',
  'fishing',
  'trawling',
  'pilotage',
  'restricted manouverability',
  'restricted manoeuvrability',
  'restricted maneuverability',
  'constrained by draft',
  'mine clearance',
  'under way',
]

/**
 * The mode a `navigation.state` value stands for, or undefined when it says
 * nothing about movement (`default`, `not under command`, reserved values,
 * anything unknown). Case, hyphens and underscores do not matter.
 */
export function modeOfState(value: unknown): Mode | undefined {
  if (typeof value !== 'string') return undefined
  const s = value
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (STATIONARY_STATES.has(s)) return 'stationary'
  if (UNDERWAY_STATES.some((u) => s === u || s.startsWith(`${u} `)))
    return 'underway'
  return undefined
}

interface Sample extends LatLon {
  time: number
}

export interface VesselModeOptions {
  /** Drift radius in metres. */
  radiusM: number
  /** How long the position must stay within the radius. */
  windowMs: number
  /** A longer gap between own positions restarts the window. */
  maxGapMs: number
}

const metres = (a: LatLon, b: LatLon) => distanceNm(a, b) * M_PER_NM

export class VesselMode {
  private state?: Mode
  private samples: Sample[] = []
  private lastPositionAt?: number
  private drift: Mode = 'unknown'
  /** The mean position while stationary by drift. */
  private anchor?: LatLon
  private readonly sampleMs: number

  constructor(private readonly opts: VesselModeOptions) {
    this.sampleMs = Math.max(
      MIN_SAMPLE_MS,
      Math.ceil(opts.windowMs / (MAX_DRIFT_SAMPLES - 1)),
    )
  }

  /** A `navigation.state` value. Unrecognised values hand over to drift. */
  setState(value: unknown): void {
    this.state = modeOfState(value)
  }

  /** An own position, as `navigation.position` delivers it. */
  position(position: unknown, time: number): void {
    if (!position || typeof position !== 'object') return
    const { latitude: lat, longitude: lon } = position as Record<
      string,
      unknown
    >
    if (
      typeof lat !== 'number' ||
      typeof lon !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      return
    const p = { lat, lon }
    if (
      this.lastPositionAt !== undefined &&
      (time - this.lastPositionAt > this.opts.maxGapMs ||
        time < this.lastPositionAt)
    )
      this.restart('unknown')
    this.lastPositionAt = time

    // Leaving the radius ends a stationary spell at once. The window starts
    // again, so the samples around the old spot cannot turn it back.
    if (this.anchor && metres(this.anchor, p) > this.opts.radiusM) {
      this.restart('underway')
    }

    const last = this.samples[this.samples.length - 1]
    if (last && time - last.time < this.sampleMs) return
    this.samples.push({ ...p, time })
    // Keep one sample at or before the window start, so a full window is
    // recognisable.
    const start = time - this.opts.windowMs
    while (this.samples.length > 1 && this.samples[1]!.time <= start)
      this.samples.shift()
    if (this.samples[0]!.time > start) return

    if (this.anchor) return
    const mean = {
      lat: this.samples.reduce((s, x) => s + x.lat, 0) / this.samples.length,
      lon: this.samples.reduce((s, x) => s + x.lon, 0) / this.samples.length,
    }
    if (this.samples.every((x) => metres(mean, x) <= this.opts.radiusM)) {
      this.anchor = mean
      this.drift = 'stationary'
    } else this.drift = 'underway'
  }

  /** The mode at `time`; positions older than the gap make drift unknown. */
  current(time: number): Mode {
    if (this.state) return this.state
    return this.driftFresh(time) ? this.drift : 'unknown'
  }

  /** What decides the mode at `time`. */
  source(time: number): ModeSource {
    if (this.state) return 'state'
    return this.driftFresh(time) && this.drift !== 'unknown' ? 'drift' : null
  }

  /** Drift samples held, for tests. */
  sampleCount(): number {
    return this.samples.length
  }

  private driftFresh(time: number): boolean {
    return (
      this.lastPositionAt !== undefined &&
      time - this.lastPositionAt <= this.opts.maxGapMs
    )
  }

  private restart(mode: Mode): void {
    this.samples = []
    this.anchor = undefined
    this.drift = mode
  }
}
