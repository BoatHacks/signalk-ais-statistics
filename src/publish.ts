// Builds the deltas of SPEC 6.2. Every counter is published every minute,
// changed or not; a gauge without data (for example no position in the last
// hour) is left out rather than published as zero or null, so only numeric
// values ever reach the history provider.
import { M_PER_NM } from './geo'
import { DAY_MS, HOUR_MS, sectorP99, type Aggregator } from './aggregate'
import { summarize } from './histogram'
import {
  DISTANCE_BIN_COUNT,
  SECTOR_CLASSES,
  SECTOR_COUNT,
  TYPE_GROUPS,
  paths,
} from './paths'

export interface PathValue {
  path: string
  value: number
}

export interface CoverageToday {
  cells: number
  areaKm2: number
}

const m = (nm: number | undefined) =>
  nm === undefined ? undefined : nm * M_PER_NM

export interface PathMeta {
  path: string
  meta: { units: string; description: string; displayUnits?: object }
}

/**
 * Default metadata for the published gauges in SI units, so the server's
 * unit preferences can convert them for display (SPEC 6.2). Counters and
 * vessel counts are plain numbers and get none.
 */
export function defaultMetadata(): PathMeta[] {
  const distance = (path: string, description: string): PathMeta => ({
    path,
    meta: { units: 'm', description, displayUnits: { category: 'distance' } },
  })
  const out = [
    distance(paths.distanceAvg, 'Average AIS reception distance, last hour'),
    distance(paths.distanceMedian, 'Median AIS reception distance, last hour'),
    distance(
      paths.distanceP95,
      '95th percentile AIS reception distance, last hour',
    ),
    distance(
      paths.distanceP99,
      '99th percentile AIS reception distance, last hour',
    ),
    distance(
      paths.distanceMax,
      'Maximum AIS reception distance, last hour (untrusted)',
    ),
  ]
  SECTOR_CLASSES.forEach((cls) => {
    for (let s = 0; s < SECTOR_COUNT; s++)
      out.push(
        distance(
          paths.sectorP99(s, cls),
          `99th percentile class ${cls.toUpperCase()} reception distance in this sector, last hour`,
        ),
      )
  })
  out.push({
    path: paths.coverageAreaToday,
    meta: {
      units: 'm2',
      description: 'Area of AIS coverage cells, today (UTC)',
    },
  })
  return out
}

export function buildValues(
  agg: Aggregator,
  time: number,
  coverage?: CoverageToday,
): PathValue[] {
  const out: PathValue[] = []
  const put = (path: string, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) out.push({ path, value })
  }

  const t = agg.totals
  put(paths.messagesTotal, t.messages)
  put(paths.positionsClassA, t.positions.A)
  put(paths.positionsClassB, t.positions.B)
  put(paths.positionsOther, t.positions.other)
  for (let i = 0; i < DISTANCE_BIN_COUNT; i++)
    put(paths.distanceBin(i), t.distanceBins[i])
  SECTOR_CLASSES.forEach((cls, c) => {
    for (let s = 0; s < SECTOR_COUNT; s++)
      put(paths.sectorCount(s, cls), t.sectorCounts[c]![s])
  })

  const hour = agg.lastHour(time)
  const d = summarize(hour.distanceBins, hour.maxNm)
  put(paths.distanceAvg, m(d.avgNm))
  put(paths.distanceMedian, m(d.medianNm))
  put(paths.distanceP95, m(d.p95Nm))
  put(paths.distanceP99, m(d.p99Nm))
  put(paths.distanceMax, m(hour.maxNm))
  const p99 = sectorP99(hour)
  SECTOR_CLASSES.forEach((cls, c) => {
    for (let s = 0; s < SECTOR_COUNT; s++)
      put(paths.sectorP99(s, cls), m(p99[c]![s]))
  })

  const v1 = agg.uniqueVessels(time, HOUR_MS)
  const v24 = agg.uniqueVessels(time, DAY_MS)
  put(paths.vesselsLast1h, v1.total)
  put(paths.vesselsLast24h, v24.total)
  for (const g of TYPE_GROUPS) {
    put(paths.vesselsByGroupLast1h(g), v1.byGroup[g])
    put(paths.vesselsByGroupLast24h(g), v24.byGroup[g])
  }

  if (coverage) {
    put(paths.coverageCellsToday, coverage.cells)
    put(paths.coverageAreaToday, coverage.areaKm2 * 1e6)
  }
  return out
}

export interface DeltaSink {
  handleMessage(id: string, delta: object): void
}

export function publish(
  sink: DeltaSink,
  pluginId: string,
  values: PathValue[],
  time: number,
): void {
  if (values.length === 0) return
  sink.handleMessage(pluginId, {
    context: 'vessels.self',
    updates: [{ timestamp: new Date(time).toISOString(), values }],
  })
}
