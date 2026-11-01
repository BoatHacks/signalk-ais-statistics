import { describe, expect, it } from 'vitest'
import { N2kIngest, normaliseMmsi } from '../src/n2k'
import {
  classAPgn,
  classBPgn,
  staticAPgn,
  staticBPartBPgn,
} from './fixtures/n2k'

describe('N2kIngest', () => {
  it('maps position reports to the same messages as sentences', () => {
    const ingest = new N2kIngest()
    expect(ingest.push(classAPgn(999000001, 0.1, 0.2))).toEqual({
      type: 1,
      mmsi: '999000001',
      lat: 0.1,
      lon: 0.2,
    })
    expect(ingest.push(classBPgn(999000002, -0.1, 0.3))).toEqual({
      type: 18,
      mmsi: '999000002',
      lat: -0.1,
      lon: 0.3,
    })
    expect(ingest.stats.sentences).toBe(2)
  })

  it('turns canboat ship type names into AIS codes', () => {
    const ingest = new N2kIngest()
    expect(ingest.push(staticAPgn(999000003, 'Cargo ship'))).toMatchObject({
      type: 5,
      shipType: 70,
    })
    expect(ingest.push(staticBPartBPgn(999000004, 'Pleasure'))).toMatchObject({
      type: 24,
      shipType: 37,
    })
  })

  it('keeps numeric lookups that have no canboat name', () => {
    const ingest = new N2kIngest()
    const pgn = staticAPgn(999000005, 98)
    pgn.fields.messageId = 5
    pgn.fields.userId = 999000005
    expect(ingest.push(pgn)).toMatchObject({ type: 5, shipType: 98 })
  })

  it('leaves out an unknown ship type name', () => {
    const msg = new N2kIngest().push(staticAPgn(999000006, 'No such type'))
    expect(msg).toEqual({ type: 5, mmsi: '999000006', name: 'SYNTHETIC' })
  })

  it('skips the own transponder', () => {
    const ingest = new N2kIngest()
    for (const t of [
      'Channel A VDL transmission',
      'Channel B VDL transmission',
      'Own information not broadcast',
    ])
      expect(ingest.push(classAPgn(999000007, 0, 0, t))).toBeUndefined()
    expect(ingest.stats.ownSkipped).toBe(3)
  })

  it('reports no position when it is missing or out of range', () => {
    const ingest = new N2kIngest()
    expect(ingest.push(classAPgn(999000008, undefined, undefined))).toEqual({
      type: 1,
      mmsi: '999000008',
    })
    expect(ingest.push(classAPgn(999000009, 91, 181))).toEqual({
      type: 1,
      mmsi: '999000009',
    })
  })

  it('ignores other PGNs and anything that is not a PGN', () => {
    const ingest = new N2kIngest()
    expect(ingest.push({ pgn: 129025, fields: {} })).toBeUndefined()
    expect(ingest.push('!AIVDM,1,1,,A,x,0*00')).toBeUndefined()
    expect(ingest.push(null)).toBeUndefined()
    expect(ingest.stats).toEqual({
      sentences: 0,
      ownSkipped: 0,
      decodeErrors: 0,
      incompleteDropped: 0,
    })
  })

  it('counts AIS PGNs without a usable type or MMSI as errors', () => {
    const ingest = new N2kIngest()
    const noType = classAPgn(999000010, 0, 0)
    noType.fields.messageId = 'Not a message'
    const noMmsi = classAPgn(999000011, 0, 0)
    delete noMmsi.fields.userId
    const badMmsi = classAPgn(999000012, 0, 0)
    badMmsi.fields.userId = 1.5
    for (const p of [noType, noMmsi, badMmsi, { pgn: 129038 }])
      expect(ingest.push(p)).toBeUndefined()
    expect(ingest.stats.decodeErrors).toBe(4)
  })

  it('pads MMSIs to nine digits as the sentence decoder does', () => {
    const ingest = new N2kIngest()
    const coast = classAPgn(999000013, 0, 0)
    coast.fields.messageId = 'Base station report'
    coast.fields.userId = 2111234
    expect(ingest.push(coast)).toMatchObject({ type: 4, mmsi: '002111234' })
    coast.fields.userId = '002111234'
    expect(ingest.push(coast)).toMatchObject({ mmsi: '002111234' })
  })

  it('ignores lookup names inherited from Object', () => {
    const pgn = classAPgn(999000014, 0, 0)
    pgn.fields.messageId = 'constructor'
    expect(new N2kIngest().push(pgn)).toBeUndefined()
  })
})

describe('normaliseMmsi', () => {
  it('accepts up to nine digits and pads them', () => {
    expect(normaliseMmsi(999000001)).toBe('999000001')
    expect(normaliseMmsi('2111234')).toBe('002111234')
    expect(normaliseMmsi(' 999000001 ')).toBe('999000001')
  })

  it('rejects anything that is not an MMSI', () => {
    for (const v of [1.5, -1, 1234567890, '12a', '', undefined, null])
      expect(normaliseMmsi(v)).toBeUndefined()
  })
})
