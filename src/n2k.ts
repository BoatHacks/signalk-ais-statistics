// NMEA 2000 ingestion (ARCHITECTURE 2.1): the server decodes every PGN with
// canboatjs and emits it on N2KAnalyzerOut, so AIS PGNs only need their
// fields mapped onto the message the sentence decoder produces. Lookup
// fields arrive as canboat names, which a local copy of the canboat lookup
// tables (the same ones n2k-signalk uses) turns back into AIS codes.
import { LOOKUPS, type LookupName } from './n2k-lookups'
import {
  MPS_PER_KNOT,
  cleanName,
  sogFromKnots,
  type AisMessage,
  type IngestStats,
} from './ingest'

/** PGNs that each carry one received AIS message. */
const AIS_PGNS = new Set([
  129038, 129039, 129040, 129041, 129792, 129793, 129794, 129795, 129796,
  129797, 129798, 129800, 129801, 129802, 129803, 129804, 129805, 129806,
  129807, 129809, 129810, 129811, 129812, 129813, 129814, 129815, 129816,
])

/** AIS_TRANSCEIVER values that mark the vessel's own transponder (VDO). */
const OWN_TRANSCEIVER = new Set([2, 3, 4])

const MMSI_RE = /^\d{1,9}$/

function lookup(table: LookupName, value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isInteger(value) ? value : undefined
  const names = LOOKUPS[table]
  if (typeof value === 'string' && Object.hasOwn(names, value))
    return names[value]
  return undefined
}

/**
 * An MMSI is nine digits, and leading zeros are significant: a coast station
 * is 00MIDxxxx and a group 0MIDxxxxx (ITU-R M.585). The sentence decoder
 * writes all nine digits, so a number or a shorter string from canboatjs is
 * padded the same way and one station never counts as two.
 */
export function normaliseMmsi(id: unknown): string | undefined {
  const s =
    typeof id === 'number' && Number.isInteger(id) && id >= 0
      ? String(id)
      : typeof id === 'string'
        ? id.trim()
        : ''
  return MMSI_RE.test(s) ? s.padStart(9, '0') : undefined
}

export class N2kIngest {
  /** `sentences` counts AIS PGNs, so the totals read the same for both inputs. */
  readonly stats: IngestStats = {
    sentences: 0,
    ownSkipped: 0,
    decodeErrors: 0,
    incompleteDropped: 0,
  }

  /**
   * Feeds one PGN as canboatjs emits it. Returns the AIS message it carries,
   * or undefined for other PGNs, the own transponder and unusable data.
   */
  push(pgn: unknown): AisMessage | undefined {
    if (typeof pgn !== 'object' || pgn === null) return undefined
    const { pgn: number, fields } = pgn as { pgn?: unknown; fields?: unknown }
    if (typeof number !== 'number' || !AIS_PGNS.has(number)) return undefined
    this.stats.sentences++
    if (typeof fields !== 'object' || fields === null) {
      this.stats.decodeErrors++
      return undefined
    }
    const f = fields as Record<string, unknown>
    const transceiver = lookup('AIS_TRANSCEIVER', f.aisTransceiverInformation)
    if (transceiver !== undefined && OWN_TRANSCEIVER.has(transceiver)) {
      this.stats.ownSkipped++
      return undefined
    }
    const type = lookup('AIS_MESSAGE_ID', f.messageId)
    const mmsi = normaliseMmsi(f.userId ?? f.sourceId)
    if (type === undefined || type < 1 || type > 27 || mmsi === undefined) {
      this.stats.decodeErrors++
      return undefined
    }
    const msg: AisMessage = { type, mmsi }
    const lat = f.latitude
    const lon = f.longitude
    if (
      typeof lat === 'number' &&
      typeof lon === 'number' &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180
    ) {
      msg.lat = lat
      msg.lon = lon
    }
    if (number === 129809) msg.part = 'A'
    else if (number === 129810) msg.part = 'B'
    // canboatjs gives m/s; the same "not available" rule applies in knots.
    const sog =
      typeof f.sog === 'number'
        ? sogFromKnots(type, f.sog / MPS_PER_KNOT)
        : undefined
    if (sog !== undefined) msg.sogMps = sog
    const shipType = lookup('SHIP_TYPE', f.typeOfShip)
    if (shipType !== undefined && (type === 5 || type === 24))
      msg.shipType = shipType
    const name = cleanName(f.name)
    if (name && (type === 5 || type === 19 || type === 24)) msg.name = name
    return msg
  }
}
