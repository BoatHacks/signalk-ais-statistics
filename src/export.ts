// Downloads of the coverage cells and the long-range log (SPEC 6.1,
// ARCHITECTURE 2.9). Pure serializers: the routes in api.ts read the day
// files and hand the result here.
//
// CSV follows RFC 4180: comma separator, CRLF line ends, a header row,
// UTF-8. Vessel names are untrusted AIS input, so a text field that a
// spreadsheet would read as a formula gets a leading apostrophe.
import { M_PER_NM } from './geo'
import type { Footprint } from './coverage'
import type { LongRangeEntry } from './longrange'

/** Export windows: today, the last 7 days, or every retained day. */
export const EXPORT_WINDOWS = ['24h', '7d', 'all'] as const
export type ExportWindow = (typeof EXPORT_WINDOWS)[number]

export const isExportWindow = (w: string): w is ExportWindow =>
  (EXPORT_WINDOWS as readonly string[]).includes(w)

type Field = string | number | boolean | undefined | null

/** Characters that make a spreadsheet read a text cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/

/** One CSV field: numbers as plain decimals, text quoted where needed. */
export function csvField(v: Field): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  const text = FORMULA_START.test(v) ? `'${v}` : v
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** A CSV document: a header row, then one row per record. */
export function csv(columns: readonly string[], rows: Field[][]): string {
  return [columns, ...rows]
    .map((r) => r.map(csvField).join(',') + '\r\n')
    .join('')
}

const COVERAGE_COLUMNS = [
  'h3_cell',
  'resolution',
  'reports',
  'min_distance_m',
  'capped',
] as const

/**
 * The cells of a footprint as H3 ids, ordered by id. With `includeCapped`
 * the sparse cells beyond the distance cap follow, marked `capped`.
 */
export function coverageCsv(f: Footprint, includeCapped: boolean): string {
  const row = (c: Footprint['cells'][number], capped: boolean): Field[] => [
    c.id,
    f.resolution,
    c.reports,
    Math.round(c.minDistanceNm * M_PER_NM),
    capped,
  ]
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  return csv(COVERAGE_COLUMNS, [
    ...[...f.cells].sort(byId).map((c) => row(c, false)),
    ...(includeCapped ? [...f.capped].sort(byId).map((c) => row(c, true)) : []),
  ])
}

const LONG_RANGE_COLUMNS = [
  'time',
  'mmsi',
  'name',
  'class',
  'ship_type',
  'distance_m',
  'bearing_deg',
  'lat',
  'lon',
  'own_lat',
  'own_lon',
] as const

/**
 * Anonymised: no MMSI, no name and no positions, since a target position
 * with distance and bearing gives the own position back.
 */
const ANONYMOUS_COLUMNS = [
  'time',
  'class',
  'ship_type',
  'distance_m',
  'bearing_deg',
] as const

const byTime = (a: LongRangeEntry, b: LongRangeEntry) =>
  a.time < b.time ? -1 : a.time > b.time ? 1 : 0

/** Long-range entries, oldest first. */
export function longRangeCsv(
  entries: LongRangeEntry[],
  anonymise: boolean,
): string {
  const sorted = [...entries].sort(byTime)
  if (anonymise)
    return csv(
      ANONYMOUS_COLUMNS,
      sorted.map((e) => [e.time, e.cls, e.shipType, e.distanceM, e.bearingDeg]),
    )
  return csv(
    LONG_RANGE_COLUMNS,
    sorted.map((e) => [
      e.time,
      e.mmsi,
      e.name,
      e.cls,
      e.shipType,
      e.distanceM,
      e.bearingDeg,
      e.lat,
      e.lon,
      e.ownLat,
      e.ownLon,
    ]),
  )
}

/**
 * Long-range entries as GeoJSON points at the reported target position,
 * oldest first. Full detail only: an anonymised entry has no position.
 */
export function longRangeGeoJson(entries: LongRangeEntry[]): {
  type: 'FeatureCollection'
  features: object[]
} {
  return {
    type: 'FeatureCollection',
    features: [...entries].sort(byTime).map((e) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
      properties: {
        time: e.time,
        mmsi: e.mmsi,
        ...(e.name === undefined ? {} : { name: e.name }),
        cls: e.cls,
        ...(e.shipType === undefined ? {} : { shipType: e.shipType }),
        distanceM: e.distanceM,
        bearingDeg: e.bearingDeg,
        ownLat: e.ownLat,
        ownLon: e.ownLon,
      },
    })),
  }
}

/**
 * The download name, for example `ais-longrange-7d-2026-11-01-anon.csv`,
 * dated with the UTC day of the export.
 */
export function exportFileName(
  set: 'coverage' | 'coverage-allcells' | 'longrange',
  window: ExportWindow,
  now: number,
  ext: 'csv' | 'geojson',
  anonymise = false,
): string {
  const date = new Date(now).toISOString().slice(0, 10)
  return `ais-${set}-${window}-${date}${anonymise ? '-anon' : ''}.${ext}`
}
