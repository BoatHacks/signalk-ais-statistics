import { describe, expect, it } from 'vitest'
import type { Footprint } from '../src/coverage'
import {
  coverageCsv,
  csv,
  csvField,
  exportFileName,
  longRangeCsv,
  longRangeGeoJson,
} from '../src/export'
import type { LongRangeEntry } from '../src/longrange'

const NM = 1852

const entry = (over: Partial<LongRangeEntry> = {}): LongRangeEntry => ({
  time: '2030-01-01T12:00:00.000Z',
  mmsi: '999000001',
  name: 'SYNTHETIC ONE',
  cls: 'A',
  shipType: 70,
  distanceM: 92600,
  bearingDeg: 45.5,
  lat: 0.58,
  lon: 0.59,
  ownLat: -0.1,
  ownLon: 0.2,
  ...over,
})

const lines = (text: string) => text.split('\r\n').slice(0, -1)

describe('csvField', () => {
  it('quotes commas, quotes and line breaks, doubling quotes', () => {
    expect(csvField('A,B')).toBe('"A,B"')
    expect(csvField('SAY "HI"')).toBe('"SAY ""HI"""')
    expect(csvField('ONE\r\nTWO')).toBe('"ONE\r\nTWO"')
    expect(csvField('PLAIN')).toBe('PLAIN')
  })

  it('guards text that a spreadsheet would read as a formula', () => {
    expect(csvField('=1+1')).toBe("'=1+1")
    expect(csvField('+31')).toBe("'+31")
    expect(csvField('-X')).toBe("'-X")
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvField('\tTAB')).toBe("'\tTAB")
    expect(csvField('=A,B')).toBe('"\'=A,B"')
  })

  it('leaves numbers alone, negative ones included', () => {
    expect(csvField(-12.5)).toBe('-12.5')
    expect(csvField(0)).toBe('0')
    expect(csvField(Number.NaN)).toBe('')
  })

  it('writes unknown values as empty fields and booleans as words', () => {
    expect(csvField(undefined)).toBe('')
    expect(csvField(null)).toBe('')
    expect(csvField(true)).toBe('true')
    expect(csvField(false)).toBe('false')
  })

  it('ends every row with CRLF, header first', () => {
    expect(csv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n')
    expect(csv(['a'], [])).toBe('a\r\n')
  })
})

describe('coverageCsv', () => {
  const f: Footprint = {
    days: ['2030-01-01'],
    mode: 'all',
    resolution: 6,
    capNm: 40,
    cells: [
      { id: '86754e64fffffff', minDistanceNm: 10, reports: 5 },
      { id: '86754a9a7ffffff', minDistanceNm: 2.5, reports: 40 },
    ],
    cappedCells: 1,
    capped: [{ id: '8675ffff7ffffff', minDistanceNm: 300, reports: 1 }],
    areaKm2: 72,
  }

  it('lists H3 ids by id with resolution, reports and distance in metres', () => {
    expect(lines(coverageCsv(f, false))).toEqual([
      'h3_cell,resolution,reports,min_distance_m,capped',
      `86754a9a7ffffff,6,40,${Math.round(2.5 * NM)},false`,
      `86754e64fffffff,6,5,${10 * NM},false`,
    ])
  })

  it('adds the cells beyond the cap only when asked', () => {
    const rows = lines(coverageCsv(f, true))
    expect(rows).toHaveLength(4)
    expect(rows[3]).toBe(`8675ffff7ffffff,6,1,${300 * NM},true`)
  })

  it('gives a header only for an empty footprint', () => {
    expect(
      coverageCsv({ ...f, cells: [], capped: [], cappedCells: 0 }, true),
    ).toBe('h3_cell,resolution,reports,min_distance_m,capped\r\n')
  })
})

describe('longRangeCsv', () => {
  const later = entry({
    time: '2030-01-01T13:00:00.000Z',
    mmsi: '999000002',
    name: undefined,
    shipType: undefined,
    cls: 'B',
  })

  it('writes full detail, oldest first', () => {
    expect(lines(longRangeCsv([later, entry()], false))).toEqual([
      'time,mmsi,name,class,ship_type,distance_m,bearing_deg,lat,lon,own_lat,own_lon',
      '2030-01-01T12:00:00.000Z,999000001,SYNTHETIC ONE,A,70,92600,45.5,0.58,0.59,-0.1,0.2',
      '2030-01-01T13:00:00.000Z,999000002,,B,,92600,45.5,0.58,0.59,-0.1,0.2',
    ])
  })

  it('keeps an MMSI a text field with its leading zeros', () => {
    const row = lines(longRangeCsv([entry({ mmsi: '002111234' })], false))[1]
    expect(row!.split(',')[1]).toBe('002111234')
  })

  it('escapes hostile vessel names', () => {
    const row = lines(
      longRangeCsv([entry({ name: '=HYPERLINK("x")' })], false),
    )[1]
    expect(row).toContain('"\'=HYPERLINK(""x"")"')
  })

  it('drops identity and every position when anonymised', () => {
    const text = longRangeCsv([entry(), later], true)
    expect(lines(text)).toEqual([
      'time,class,ship_type,distance_m,bearing_deg',
      '2030-01-01T12:00:00.000Z,A,70,92600,45.5',
      '2030-01-01T13:00:00.000Z,B,,92600,45.5',
    ])
    expect(text).not.toContain('999000001')
    expect(text).not.toContain('SYNTHETIC')
    expect(text).not.toContain('0.58')
  })

  it('gives a header only for no entries', () => {
    expect(longRangeCsv([], false).split('\r\n')).toHaveLength(2)
  })
})

describe('longRangeGeoJson', () => {
  it('places points at the reported position, longitude first', () => {
    const g = longRangeGeoJson([entry()]) as {
      features: {
        geometry: { coordinates: number[] }
        properties: Record<string, unknown>
      }[]
    }
    expect(g.features[0]!.geometry.coordinates).toEqual([0.59, 0.58])
    expect(g.features[0]!.properties).toEqual({
      time: '2030-01-01T12:00:00.000Z',
      mmsi: '999000001',
      name: 'SYNTHETIC ONE',
      cls: 'A',
      shipType: 70,
      distanceM: 92600,
      bearingDeg: 45.5,
      ownLat: -0.1,
      ownLon: 0.2,
    })
  })

  it('leaves out unknown names and types', () => {
    const g = longRangeGeoJson([
      entry({ name: undefined, shipType: undefined }),
    ])
    const p = (g.features[0] as { properties: object }).properties
    expect(p).not.toHaveProperty('name')
    expect(p).not.toHaveProperty('shipType')
  })

  it('is an empty collection for no entries', () => {
    expect(longRangeGeoJson([])).toEqual({
      type: 'FeatureCollection',
      features: [],
    })
  })
})

describe('exportFileName', () => {
  const t = Date.UTC(2030, 0, 1, 23, 59)
  it('names the set, window and UTC day', () => {
    expect(exportFileName('longrange', '7d', t, 'csv', true)).toBe(
      'ais-longrange-7d-2030-01-01-anon.csv',
    )
    expect(exportFileName('coverage', 'all', t, 'csv')).toBe(
      'ais-coverage-all-2030-01-01.csv',
    )
    expect(exportFileName('longrange', '24h', t, 'geojson')).toBe(
      'ais-longrange-24h-2030-01-01.geojson',
    )
  })
})
