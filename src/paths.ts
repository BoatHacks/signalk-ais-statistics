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

/**
 * Message health counters (SPEC 2.8), in the order of their paths. Each
 * only counts; nothing is removed from the other statistics.
 */
export const HEALTH_KINDS = [
  'decodeErrors',
  'incomplete',
  'duplicates',
  'duplicatesCrossEvent',
  'positionInvalid',
  'implausibleJumps',
  'noOwnPosition',
] as const
export type HealthKind = (typeof HEALTH_KINDS)[number]

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
  healthDecodeErrors: p('health.decodeErrors'),
  healthIncomplete: p('health.incomplete'),
  healthDuplicates: p('health.duplicates'),
  healthDuplicatesCrossEvent: p('health.duplicatesCrossEvent'),
  healthPositionInvalid: p('health.positionInvalid'),
  healthImplausibleJumps: p('health.implausibleJumps'),
  healthNoOwnPosition: p('health.noOwnPosition'),

  // Gauges, in SI units: distances in metres, areas in square metres.
  distanceAvg: p('distance.avg'),
  distanceMedian: p('distance.median'),
  distanceP95: p('distance.p95'),
  distanceP99: p('distance.p99'),
  distanceMax: p('distance.max'),
  sectorP99: (sector: number, cls: SectorClass) =>
    p(`sectors.${sectorLabel(sector)}.${cls}.p99`),
  sectorMax: (sector: number, cls: SectorClass) =>
    p(`sectors.${sectorLabel(sector)}.${cls}.max`),
  vesselsLast1h: p('vessels.last1h'),
  vesselsLast24h: p('vessels.last24h'),
  vesselsByGroupLast1h: (group: TypeGroup) =>
    p(`vessels.byGroup.${group}.last1h`),
  vesselsByGroupLast24h: (group: TypeGroup) =>
    p(`vessels.byGroup.${group}.last24h`),
  coverageAreaToday: p('coverage.area.today'),
  coverageCellsToday: p('coverage.cells.today'),
}

/** All distance bin counter paths, in bin order. */
export const distanceBinPaths: string[] = Array.from(
  { length: DISTANCE_BIN_COUNT },
  (_, i) => paths.distanceBin(i),
)

/** The counter path of each health kind. */
export const healthPaths: Record<HealthKind, string> = {
  decodeErrors: paths.healthDecodeErrors,
  incomplete: paths.healthIncomplete,
  duplicates: paths.healthDuplicates,
  duplicatesCrossEvent: paths.healthDuplicatesCrossEvent,
  positionInvalid: paths.healthPositionInvalid,
  implausibleJumps: paths.healthImplausibleJumps,
  noOwnPosition: paths.healthNoOwnPosition,
}
