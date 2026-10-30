// Published SignalK path names (SPEC 6.2). These names are the persistence
// schema: whatever history provider the server runs stores them, and the
// HistoryReader reads them back. Define every path here and nowhere else.

export const PATH_PREFIX = 'sensors.ais.statistics'

/** Number of distance histogram bins (see histogram.ts for their edges). */
export const DISTANCE_BIN_COUNT = 32
/** Number of bearing sectors, 15 degrees each, clockwise from true north. */
export const SECTOR_COUNT = 24
export const SECTOR_WIDTH_DEG = 360 / SECTOR_COUNT

export const SECTOR_CLASSES = ['a', 'b'] as const
export type SectorClass = (typeof SECTOR_CLASSES)[number]

export const TYPE_GROUPS = [
  'cargo',
  'tanker',
  'passenger',
  'fishing',
  'pleasureCraft',
  'other',
  'unknown',
] as const
export type TypeGroup = (typeof TYPE_GROUPS)[number]

const p = (suffix: string): string => `${PATH_PREFIX}.${suffix}`

/** Two-digit bin label, 00 to 31. */
export function binLabel(bin: number): string {
  return String(bin).padStart(2, '0')
}

/** Three-digit label of a sector: its starting bearing in degrees, 000 to 345. */
export function sectorLabel(sector: number): string {
  return String(sector * SECTOR_WIDTH_DEG).padStart(3, '0')
}

export const paths = {
  // Counters: monotonic, counted since the plugin started.
  messagesTotal: p('messages.total'),
  positionsClassA: p('positions.classA'),
  positionsClassB: p('positions.classB'),
  positionsOther: p('positions.other'),
  distanceBin: (bin: number) => p(`distance.bin.${binLabel(bin)}`),
  sectorCount: (sector: number, cls: SectorClass) =>
    p(`sectors.${sectorLabel(sector)}.${cls}.count`),

  // Gauges.
  distanceAvgNm: p('distance.avgNm'),
  distanceMedianNm: p('distance.medianNm'),
  distanceP95Nm: p('distance.p95Nm'),
  distanceP99Nm: p('distance.p99Nm'),
  distanceMaxNm: p('distance.maxNm'),
  sectorP99Nm: (sector: number, cls: SectorClass) =>
    p(`sectors.${sectorLabel(sector)}.${cls}.p99Nm`),
  vesselsLast1h: p('vessels.last1h'),
  vesselsLast24h: p('vessels.last24h'),
  vesselsByGroupLast1h: (group: TypeGroup) =>
    p(`vessels.byGroup.${group}.last1h`),
  vesselsByGroupLast24h: (group: TypeGroup) =>
    p(`vessels.byGroup.${group}.last24h`),
  coverageAreaKm2Today: p('coverage.areaKm2.today'),
  coverageCellsToday: p('coverage.cells.today'),
}

/** All distance bin counter paths, in bin order. */
export const distanceBinPaths: string[] = Array.from(
  { length: DISTANCE_BIN_COUNT },
  (_, i) => paths.distanceBin(i),
)
