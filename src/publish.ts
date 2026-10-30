// Builds the deltas of SPEC 6.2. Every counter is published every minute,
// changed or not; a gauge without data (for example no position in the last
// hour) is left out rather than published as zero or null, so only numeric
// values ever reach the history provider.
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
  put(paths.distanceAvgNm, d.avgNm)
  put(paths.distanceMedianNm, d.medianNm)
  put(paths.distanceP95Nm, d.p95Nm)
  put(paths.distanceP99Nm, d.p99Nm)
  put(paths.distanceMaxNm, hour.maxNm)
  const p99 = sectorP99(hour)
  SECTOR_CLASSES.forEach((cls, c) => {
    for (let s = 0; s < SECTOR_COUNT; s++)
      put(paths.sectorP99Nm(s, cls), p99[c]![s])
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
    put(paths.coverageAreaKm2Today, coverage.areaKm2)
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
