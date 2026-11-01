// Raw sentence ingestion (ARCHITECTURE 2.1): keeps !xxVDM, drops !xxVDO,
// reassembles multipart messages and decodes them with ggencoder. Decode
// errors are counted and swallowed so that untrusted input never throws
// into the server.
import { AisDecode } from 'ggencoder'
import { isPositionReport } from './classify'

export const MPS_PER_KNOT = 1852 / 3600

export interface AisMessage {
  type: number
  mmsi: string
  /** Present only when the report carries a position within range. */
  lat?: number
  lon?: number
  /** AIS ship type code, from message 5 and message 24 part B. */
  shipType?: number
  /** Vessel name, from message 5, 19 and 24 part A. */
  name?: string
  /** Reported speed over ground in m/s, from position reports. */
  sogMps?: number
  /** Part of a message 24: A carries the name, B the ship type. */
  part?: 'A' | 'B'
}

/**
 * Reported speed over ground in m/s from a value in knots, or undefined
 * when it is the "not available" value: 102.3 kn (1023 in steps of 0.1),
 * or 1023 kn for message 9, whose steps are whole knots.
 */
export function sogFromKnots(type: number, knots: unknown): number | undefined {
  if (!isPositionReport(type)) return undefined
  if (typeof knots !== 'number' || !Number.isFinite(knots) || knots < 0)
    return undefined
  if (knots > (type === 9 ? 1022.5 : 102.25)) return undefined
  return knots * MPS_PER_KNOT
}

/**
 * A vessel name as transmitted, without the `@` padding of six-bit text
 * and surrounding spaces; undefined when nothing is left.
 */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.replace(/@+/g, ' ').replace(/\s+/g, ' ').trim()
  return s === '' ? undefined : s.slice(0, 40)
}

export interface IngestStats {
  sentences: number
  ownSkipped: number
  decodeErrors: number
  incompleteDropped: number
}

interface Pending {
  session: Record<string, unknown>
  next: number
  started: number
}

const MAX_PENDING = 256
const PART_TIMEOUT_MS = 10_000

const VDM_RE = /^!([A-Z]{2})(VD[MO]),/

export class Ingest {
  readonly stats: IngestStats = {
    sentences: 0,
    ownSkipped: 0,
    decodeErrors: 0,
    incompleteDropped: 0,
  }
  private pending = new Map<string, Pending>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Feeds one raw sentence. Returns the decoded message when the sentence
   * completes one, otherwise undefined (own vessel, partial, not AIS or
   * undecodable).
   */
  push(raw: string): AisMessage | undefined {
    if (typeof raw !== 'string') return undefined
    // Strip an NMEA 4.10 tag block or any other prefix before the sentence.
    const start = raw.indexOf('!')
    if (start < 0) return undefined
    const sentence = raw.slice(start).trim()
    const m = VDM_RE.exec(sentence)
    if (!m) return undefined
    this.stats.sentences++
    if (m[2] === 'VDO') {
      this.stats.ownSkipped++
      return undefined
    }
    try {
      return this.decode(sentence)
    } catch {
      this.stats.decodeErrors++
      return undefined
    }
  }

  private decode(sentence: string): AisMessage | undefined {
    const fields = sentence.split(',')
    const count = Number(fields[1])
    const index = Number(fields[2])
    if (!Number.isInteger(count) || !Number.isInteger(index) || count < 1) {
      this.stats.decodeErrors++
      return undefined
    }
    if (count === 1) return this.finish(new AisDecode(sentence))

    // Multipart: one decoder session per sequence, so interleaved messages
    // on different sequence ids or channels do not corrupt each other.
    this.expire()
    const key = `${fields[0]}|${count}|${fields[3]}|${fields[4]}`
    let p = this.pending.get(key)
    if (index === 1) {
      if (p) this.stats.incompleteDropped++
      if (!p && this.pending.size >= MAX_PENDING) this.dropOldest()
      p = { session: {}, next: 1, started: this.now() }
      this.pending.set(key, p)
    }
    if (!p || p.next !== index) {
      // Missing an earlier part: the message cannot be completed.
      if (p) {
        this.pending.delete(key)
        this.stats.incompleteDropped++
      }
      this.stats.decodeErrors++
      return undefined
    }
    const decoded = new AisDecode(sentence, p.session)
    if (decoded.error) {
      this.pending.delete(key)
      this.stats.decodeErrors++
      return undefined
    }
    p.next++
    if (index < count) return undefined
    this.pending.delete(key)
    return this.finish(decoded)
  }

  private finish(d: InstanceType<typeof AisDecode>): AisMessage | undefined {
    if (!d.valid || d.aistype === undefined || d.mmsi === undefined) {
      this.stats.decodeErrors++
      return undefined
    }
    const msg: AisMessage = { type: d.aistype, mmsi: d.mmsi }
    if (
      typeof d.lat === 'number' &&
      typeof d.lon === 'number' &&
      Number.isFinite(d.lat) &&
      Number.isFinite(d.lon) &&
      Math.abs(d.lat) <= 90 &&
      Math.abs(d.lon) <= 180
    ) {
      msg.lat = d.lat
      msg.lon = d.lon
    }
    if (d.aistype === 24 && (d.part === 0 || d.part === 1))
      msg.part = d.part === 0 ? 'A' : 'B'
    const sog = sogFromKnots(d.aistype, d.sog)
    if (sog !== undefined) msg.sogMps = sog
    if (typeof d.cargo === 'number' && (d.aistype === 5 || d.aistype === 24))
      msg.shipType = d.cargo
    const name = cleanName(d.shipname)
    if (name && (d.aistype === 5 || d.aistype === 19 || d.aistype === 24))
      msg.name = name
    return msg
  }

  private expire(): void {
    const limit = this.now() - PART_TIMEOUT_MS
    for (const [key, p] of this.pending) {
      if (p.started < limit) {
        this.pending.delete(key)
        this.stats.incompleteDropped++
      }
    }
  }

  private dropOldest(): void {
    const first = this.pending.keys().next()
    if (!first.done) {
      this.pending.delete(first.value)
      this.stats.incompleteDropped++
    }
  }
}
