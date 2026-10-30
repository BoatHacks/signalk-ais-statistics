// Synthetic AIS sentences for tests. MMSIs use the unallocated 999 MID and
// positions are around 0N 0E, so nothing here refers to a real vessel or
// place. Sentences are built with ggencoder's encoder.
import { AisEncode } from 'ggencoder'

export const OWN = { lat: 0, lon: 0 }

export function checksum(body: string): string {
  let c = 0
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i)
  return c.toString(16).toUpperCase().padStart(2, '0')
}

function encode(msg: Record<string, unknown>): string {
  const e = new AisEncode(msg)
  if (!e.valid) throw new Error('encoder rejected fixture')
  return e.nmea
}

export function classA(
  mmsi: number,
  lat: number | undefined,
  lon: number | undefined,
  aistype = 1,
): string {
  return encode({ aistype, repeat: 0, mmsi, navstatus: 0, lat, lon, sog: 5 })
}

export function classB(
  mmsi: number,
  lat: number | undefined,
  lon: number | undefined,
): string {
  return encode({ aistype: 18, repeat: 0, mmsi, lat, lon, sog: 3 })
}

export function staticB(mmsi: number, cargo: number): string {
  return encode({
    aistype: 24,
    repeat: 0,
    mmsi,
    part: 1,
    cargo,
    callsign: 'TEST',
  })
}

/** Message 5 split into two sentences, as receivers send it. */
export function staticA(mmsi: number, cargo: number, seq = 1): string[] {
  const single = encode({
    aistype: 5,
    repeat: 0,
    mmsi,
    imo: 0,
    callsign: 'TEST',
    shipname: 'SYNTHETIC',
    cargo,
    dimA: 10,
    dimB: 10,
    dimC: 2,
    dimD: 2,
    etaMo: 1,
    etaDay: 1,
    etaHr: 0,
    etaMin: 0,
    draught: 2,
    destination: 'NOWHERE',
  })
  const payload = single.split(',')[5] as string
  const half = Math.ceil(payload.length / 2)
  const parts = [payload.slice(0, half), payload.slice(half)]
  return parts.map((part, i) => {
    const fill = i === parts.length - 1 ? (6 * payload.length - 424) % 6 : 0
    const body = `AIVDM,2,${i + 1},${seq},A,${part},${fill}`
    return `!${body}*${checksum(body)}`
  })
}

/** Corrupts the checksum of a sentence. */
export function badChecksum(sentence: string): string {
  const [body] = sentence.split('*')
  return `${body}*00`
}

/** Turns a received sentence into the vessel's own transponder sentence. */
export function asOwn(sentence: string): string {
  const body = sentence
    .slice(1, sentence.indexOf('*'))
    .replace('AIVDM', 'AIVDO')
  return `!${body}*${checksum(body)}`
}
