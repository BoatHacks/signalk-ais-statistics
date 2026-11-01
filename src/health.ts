// Message health (SPEC 2.8, ARCHITECTURE 2.4a): the duplicate detector and
// the implausible jump tracker. One instance serves every configured event,
// so a message that reaches two events is seen twice by the same detector.
// It only judges; the aggregator counts the verdict and nothing is dropped
// from distance, sectors or coverage (SPEC 2.3). Pure and clock-injectable:
// every method takes the reception time.
import { MAX_VESSELS } from './aggregate'
import { isPositionReport } from './classify'
import { M_PER_NM, distanceNm } from './geo'
import { MPS_PER_KNOT, type AisMessage } from './ingest'

/** A copy received within this long of the first counts as a duplicate. */
export const DUPLICATE_WINDOW_MS = 2000
/**
 * Positions closer than this in latitude and longitude match (about 2 m),
 * so the rounding of the two decoders cannot split one message in two.
 */
export const DUPLICATE_POSITION_DEG = 2e-5
/** Copies remembered per key, so a flood cannot grow the detector. */
const MAX_COPIES_PER_KEY = 16
/** Distance a vessel must cover before its speed is judged. */
export const MIN_JUMP_M = 500
/** Shortest time over which a speed is judged. */
export const MIN_JUMP_GAP_MS = 1000
/** A position within MIN_JUMP_M replaces an anchor older than this. */
export const ANCHOR_MAX_AGE_MS = 60_000
const PRUNE_EVERY_MS = 1000

export interface JumpLimits {
  /** Metres per second, for ordinary vessels and unknown ship types. */
  normalMps: number
  /** Ship types 20 to 29 (WIG) and 40 to 49 (high-speed craft). */
  highSpeedMps: number
  /** Message 9, SAR aircraft. */
  aircraftMps: number
}

export function limitsFromKnots(
  normal: number,
  highSpeed: number,
  aircraft: number,
): JumpLimits {
  return {
    normalMps: normal * MPS_PER_KNOT,
    highSpeedMps: highSpeed * MPS_PER_KNOT,
    aircraftMps: aircraft * MPS_PER_KNOT,
  }
}

/** The speed limit that applies to a sender. */
export function limitFor(
  limits: JumpLimits,
  messageType: number,
  shipType: number | undefined,
): number {
  if (messageType === 9) return limits.aircraftMps
  if (
    shipType !== undefined &&
    ((shipType >= 20 && shipType <= 29) || (shipType >= 40 && shipType <= 49))
  )
    return limits.highSpeedMps
  return limits.normalMps
}

/** An implied speed between two positions of one sender. */
export interface SpeedSample {
  mmsi: string
  messageType: number
  /** Reception time of the later position. */
  time: number
  speedMps: number
  /** Speed over ground reported with the later position. */
  sogMps?: number
  limitMps: number
  implausible: boolean
  gapS: number
  fromLat: number
  fromLon: number
  lat: number
  lon: number
}

export interface Verdict {
  /** Set when the message repeats one seen within the last 2 s. */
  duplicate?: 'sameEvent' | 'crossEvent'
  /** Set when the message completed a speed measurement. */
  speed?: SpeedSample
}

interface Copy {
  event: string
  time: number
  lat?: number
  lon?: number
}

interface Anchor {
  lat: number
  lon: number
  time: number
}

function samePosition(a: Copy, msg: AisMessage): boolean {
  if (a.lat === undefined || msg.lat === undefined)
    return a.lat === undefined && msg.lat === undefined
  return (
    Math.abs(a.lat - msg.lat) <= DUPLICATE_POSITION_DEG &&
    Math.abs(a.lon! - msg.lon!) <= DUPLICATE_POSITION_DEG
  )
}

export class Health {
  private copies = new Map<string, Copy[]>()
  private anchors = new Map<string, Anchor>()
  private lastPrune = -Infinity

  constructor(
    private limits: JumpLimits,
    /** Anchors of senders not heard for this long are forgotten. */
    private readonly expiryMs: number,
  ) {}

  setLimits(limits: JumpLimits): void {
    this.limits = limits
  }

  /**
   * Judges one decoded message received on `event` at `time`. `shipType`
   * is the sender's ship type as far as it is known.
   */
  check(
    msg: AisMessage,
    event: string,
    shipType: number | undefined,
    time: number,
  ): Verdict {
    this.prune(time)
    const duplicate = this.duplicate(msg, event, time)
    if (duplicate) return { duplicate }
    const speed = this.jump(msg, shipType, time)
    return speed ? { speed } : {}
  }

  private duplicate(
    msg: AisMessage,
    event: string,
    time: number,
  ): Verdict['duplicate'] {
    const key = `${msg.mmsi}|${msg.type}|${msg.part ?? ''}`
    let list = this.copies.get(key)
    let found: Verdict['duplicate']
    if (list) {
      for (const c of list) {
        const age = time - c.time
        if (age < 0 || age >= DUPLICATE_WINDOW_MS || !samePosition(c, msg))
          continue
        if (c.event === event) {
          found = 'sameEvent'
          break
        }
        found = 'crossEvent'
      }
    } else {
      list = []
      this.copies.set(key, list)
    }
    list.push({ event, time, lat: msg.lat, lon: msg.lon })
    if (list.length > MAX_COPIES_PER_KEY) list.shift()
    return found
  }

  private jump(
    msg: AisMessage,
    shipType: number | undefined,
    time: number,
  ): SpeedSample | undefined {
    if (!isPositionReport(msg.type)) return undefined
    if (msg.lat === undefined || msg.lon === undefined) return undefined
    const here = { lat: msg.lat, lon: msg.lon, time }
    const anchor = this.anchors.get(msg.mmsi)
    if (!anchor) {
      this.setAnchor(msg.mmsi, here)
      return undefined
    }
    const gapMs = time - anchor.time
    const m = distanceNm(anchor, here) * M_PER_NM
    if (m < MIN_JUMP_M || gapMs < MIN_JUMP_GAP_MS) {
      if (gapMs > ANCHOR_MAX_AGE_MS || gapMs < 0) this.setAnchor(msg.mmsi, here)
      return undefined
    }
    this.setAnchor(msg.mmsi, here)
    const speedMps = m / (gapMs / 1000)
    const limitMps = limitFor(this.limits, msg.type, shipType)
    const sample: SpeedSample = {
      mmsi: msg.mmsi,
      messageType: msg.type,
      time,
      speedMps,
      limitMps,
      implausible: speedMps > limitMps,
      gapS: gapMs / 1000,
      fromLat: anchor.lat,
      fromLon: anchor.lon,
      lat: msg.lat,
      lon: msg.lon,
    }
    if (msg.sogMps !== undefined) sample.sogMps = msg.sogMps
    return sample
  }

  private setAnchor(mmsi: string, a: Anchor): void {
    // Re-insert so the map stays ordered by update, oldest first.
    if (this.anchors.has(mmsi)) this.anchors.delete(mmsi)
    else if (this.anchors.size >= MAX_VESSELS) {
      const oldest = this.anchors.keys().next()
      if (!oldest.done) this.anchors.delete(oldest.value)
    }
    this.anchors.set(mmsi, a)
  }

  private prune(time: number): void {
    if (time - this.lastPrune < PRUNE_EVERY_MS) return
    this.lastPrune = time
    for (const [key, list] of this.copies) {
      const kept = list.filter((c) => time - c.time < DUPLICATE_WINDOW_MS)
      if (kept.length === 0) this.copies.delete(key)
      else if (kept.length !== list.length) this.copies.set(key, kept)
    }
    const from = time - this.expiryMs
    for (const [mmsi, a] of this.anchors) {
      if (a.time >= from) break
      this.anchors.delete(mmsi)
    }
  }
}
