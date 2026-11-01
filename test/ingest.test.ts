import { describe, expect, it } from 'vitest'
import { Ingest, cleanName } from '../src/ingest'
import {
  asOwn,
  badChecksum,
  classA,
  classB,
  staticA,
  staticB,
} from './fixtures/ais'

describe('Ingest', () => {
  it('decodes class A and B position reports', () => {
    const ingest = new Ingest()
    const a = ingest.push(classA(999000001, 0.5, -0.25))
    expect(a).toMatchObject({ type: 1, mmsi: '999000001' })
    expect(a?.lat).toBeCloseTo(0.5, 4)
    expect(a?.lon).toBeCloseTo(-0.25, 4)
    const b = ingest.push(classB(999000002, -0.1, 0.2))
    expect(b).toMatchObject({ type: 18, mmsi: '999000002' })
    expect(b?.lat).toBeCloseTo(-0.1, 4)
  })

  it('skips own transponder sentences', () => {
    const ingest = new Ingest()
    expect(ingest.push(asOwn(classA(999000001, 0, 0)))).toBeUndefined()
    expect(ingest.stats.ownSkipped).toBe(1)
  })

  it('accepts a tag block prefix and other talker ids', () => {
    const ingest = new Ingest()
    const s = classA(999000003, 0.1, 0.1).replace('!AIVDM', '!BSVDM')
    const body = s.slice(1, s.indexOf('*'))
    let c = 0
    for (const ch of body) c ^= ch.charCodeAt(0)
    const fixed = `!${body}*${c.toString(16).toUpperCase().padStart(2, '0')}`
    expect(ingest.push(`\\s:test,c:0*00\\${fixed}`)?.mmsi).toBe('999000003')
  })

  it('reassembles multipart messages and reads the ship type', () => {
    const ingest = new Ingest()
    const [p1, p2] = staticA(999000004, 70)
    expect(ingest.push(p1!)).toBeUndefined()
    const msg = ingest.push(p2!)
    expect(msg).toMatchObject({
      type: 5,
      mmsi: '999000004',
      shipType: 70,
      name: 'SYNTHETIC',
    })
    expect(msg?.lat).toBeUndefined()
  })

  it('cleans vessel names of padding', () => {
    expect(cleanName('SYNTHETIC@@@@')).toBe('SYNTHETIC')
    expect(cleanName('  TWO   WORDS ')).toBe('TWO WORDS')
    expect(cleanName('@@@@')).toBeUndefined()
    expect(cleanName(42)).toBeUndefined()
  })

  it('keeps interleaved multipart messages apart', () => {
    const ingest = new Ingest()
    const [a1, a2] = staticA(999000005, 30, 1)
    const [b1, b2] = staticA(999000006, 80, 2)
    ingest.push(a1!)
    ingest.push(b1!)
    expect(ingest.push(a2!)).toMatchObject({ mmsi: '999000005', shipType: 30 })
    expect(ingest.push(b2!)).toMatchObject({ mmsi: '999000006', shipType: 80 })
  })

  it('drops a second part without its first', () => {
    const ingest = new Ingest()
    const [, p2] = staticA(999000007, 70)
    expect(ingest.push(p2!)).toBeUndefined()
    expect(ingest.stats.decodeErrors).toBe(1)
  })

  it('expires partial messages', () => {
    let now = 0
    const ingest = new Ingest(() => now)
    const [p1, p2] = staticA(999000008, 70)
    ingest.push(p1!)
    now = 60_000
    ingest.push(classA(999000009, 0, 0))
    ingest.push(staticA(999000010, 70, 3)[0]!)
    expect(ingest.push(p2!)).toBeUndefined()
    expect(ingest.stats.incompleteDropped).toBe(1)
  })

  it('reads the ship type of message 24 part B', () => {
    const ingest = new Ingest()
    expect(ingest.push(staticB(999000011, 37))).toMatchObject({
      type: 24,
      shipType: 37,
    })
  })

  it('counts bad checksums and garbage as decode errors without throwing', () => {
    const ingest = new Ingest()
    expect(ingest.push(badChecksum(classA(999000012, 0, 0)))).toBeUndefined()
    expect(ingest.push('!AIVDM,1,1,,A,,0*00')).toBeUndefined()
    expect(ingest.push('!AIVDM,x,y')).toBeUndefined()
    expect(ingest.push('$GPGGA,123519,4807.038,N')).toBeUndefined()
    expect(ingest.push(undefined as unknown as string)).toBeUndefined()
    expect(ingest.stats.decodeErrors).toBe(3)
  })

  it('keeps the message but drops a position that is not available', () => {
    const ingest = new Ingest()
    const msg = ingest.push(classA(999000013, undefined, undefined))
    expect(msg).toMatchObject({ type: 1, mmsi: '999000013' })
    expect(msg?.lat).toBeUndefined()
  })

  it('drops an out-of-range latitude', () => {
    const ingest = new Ingest()
    const msg = ingest.push(classA(999000014, -95, 10))
    expect(msg?.mmsi).toBe('999000014')
    expect(msg?.lat).toBeUndefined()
  })
})
