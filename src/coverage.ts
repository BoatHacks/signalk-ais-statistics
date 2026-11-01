// Coverage (ARCHITECTURE 2.5, SPEC 2.4 and 8): the H3 cells that contained
// at least one target position, per UTC day. Each day lives in a small JSON
// file in the plugin data directory with, per cell, the shortest distance
// and the number of reports seen there, plus the day's distance histogram.
// The histogram lets a window's percentile cap be computed from the files
// alone, with or without a history provider.
import { M_PER_NM } from './geo'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  cellToBoundary,
  cellToCenterChild,
  cellToParent,
  getHexagonAreaAvg,
  getResolution,
  isValidCell,
  latLngToCell,
} from 'h3-js'
import { DAY_MS } from './aggregate'
import { addInto, binOf, emptyBins, percentileNm } from './histogram'
import { DISTANCE_BIN_COUNT } from './paths'

/** Upper bound on cells kept for one day. */
export const MAX_CELLS_PER_DAY = 20_000
const FILE_VERSION = 1

/** [shortest distance in nm, number of reports] */
type CellStats = [number, number]

export interface DayFile {
  version: number
  date: string
  resolution: number
  cells: Record<string, CellStats>
  distanceBins: number[]
}

export interface Footprint {
  days: string[]
  resolution: number
  /** Distance cap applied, or null when the cap is disabled or there is no data. */
  capNm: number | null
  cells: { id: string; minDistanceNm: number; reports: number }[]
  /** Cells left out by the cap. */
  cappedCells: number
  /** The cells left out by the cap, for views that show them anyway. */
  capped: { id: string; minDistanceNm: number; reports: number }[]
  areaKm2: number
}

export function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

const FILE_RE = /^coverage-(\d{4}-\d{2}-\d{2})\.json$/

function emptyDay(date: string, resolution: number): DayFile {
  return {
    version: FILE_VERSION,
    date,
    resolution,
    cells: {},
    distanceBins: emptyBins(),
  }
}

function isDayFile(x: unknown): x is DayFile {
  const d = x as DayFile
  return (
    !!d &&
    typeof d === 'object' &&
    typeof d.date === 'string' &&
    typeof d.resolution === 'number' &&
    !!d.cells &&
    typeof d.cells === 'object' &&
    Array.isArray(d.distanceBins) &&
    d.distanceBins.length === DISTANCE_BIN_COUNT
  )
}

/** Converts a cell id to the configured resolution. */
function atResolution(id: string, resolution: number): string | undefined {
  if (!isValidCell(id)) return undefined
  const r = getResolution(id)
  if (r === resolution) return id
  return r > resolution
    ? cellToParent(id, resolution)
    : cellToCenterChild(id, resolution)
}

export class Coverage {
  private day: DayFile
  private dirty = false
  droppedCells = 0

  constructor(
    private readonly dir: string,
    private readonly resolution: number,
    private readonly retentionDays: number,
    private readonly percentile: number,
    now: number,
  ) {
    this.day = emptyDay(utcDay(now), resolution)
  }

  private file(date: string): string {
    return join(this.dir, `coverage-${date}.json`)
  }

  /** Loads today's file so a restart continues the day. */
  async load(now: number): Promise<void> {
    const date = utcDay(now)
    const existing = await this.read(date)
    // Reports may have arrived while the file was read; merge, do not replace.
    if (existing && this.day.date === date) {
      this.mergeDay(this.day, existing)
      this.dirty = true
    }
  }

  /** Records one located report. */
  add(lat: number, lon: number, distanceNm: number, time: number): void {
    const date = utcDay(time)
    if (date !== this.day.date) {
      // The day changed: write the finished day, start the next one.
      void this.flush().catch(() => undefined)
      this.day = emptyDay(date, this.resolution)
    }
    let id: string
    try {
      id = latLngToCell(lat, lon, this.resolution)
    } catch {
      return
    }
    this.day.distanceBins[binOf(distanceNm)]!++
    const c = this.day.cells[id]
    if (c) {
      c[0] = Math.min(c[0], distanceNm)
      c[1]++
    } else if (Object.keys(this.day.cells).length < MAX_CELLS_PER_DAY) {
      this.day.cells[id] = [distanceNm, 1]
    } else {
      this.droppedCells++
    }
    this.dirty = true
  }

  /** Cell count and area for the current day, with the percentile cap. */
  today(now: number): { cells: number; areaKm2: number } {
    const f = this.build([this.currentDay(now)])
    return { cells: f.cells.length, areaKm2: f.areaKm2 }
  }

  /** Union of the last `days` UTC days, today included. */
  async footprint(days: number, now: number): Promise<Footprint> {
    const today = utcDay(now)
    const dates: string[] = []
    for (let i = days - 1; i >= 0; i--) dates.push(utcDay(now - i * DAY_MS))
    const files: DayFile[] = []
    for (const date of dates) {
      if (date === today) files.push(this.currentDay(now))
      else {
        const f = await this.read(date)
        if (f) files.push(f)
      }
    }
    return { ...this.build(files), days: dates }
  }

  /** Writes the current day if it changed. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    const day = this.day
    this.dirty = false
    await fs.mkdir(this.dir, { recursive: true })
    const target = this.file(day.date)
    const tmp = `${target}.tmp`
    await fs.writeFile(tmp, JSON.stringify(day))
    await fs.rename(tmp, target)
  }

  /** Deletes day files older than the retention period. */
  async prune(now: number): Promise<string[]> {
    const oldest = utcDay(now - (this.retentionDays - 1) * DAY_MS)
    let names: string[]
    try {
      names = await fs.readdir(this.dir)
    } catch {
      return []
    }
    const removed: string[] = []
    for (const name of names) {
      const m = FILE_RE.exec(name)
      if (m && m[1]! < oldest) {
        await fs.rm(join(this.dir, name), { force: true })
        removed.push(m[1]!)
      }
    }
    return removed
  }

  private currentDay(now: number): DayFile {
    return this.day.date === utcDay(now)
      ? this.day
      : emptyDay(utcDay(now), this.resolution)
  }

  private async read(date: string): Promise<DayFile | undefined> {
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(this.file(date), 'utf8'),
      )
      return isDayFile(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  private mergeDay(into: DayFile, from: DayFile): void {
    addInto(into.distanceBins, from.distanceBins)
    for (const [raw, stats] of Object.entries(from.cells)) {
      if (!Array.isArray(stats)) continue
      const [d, n] = stats
      if (typeof d !== 'number' || typeof n !== 'number') continue
      const id = atResolution(raw, into.resolution)
      if (!id) continue
      const c = into.cells[id]
      if (c) {
        c[0] = Math.min(c[0], d)
        c[1] += n
      } else into.cells[id] = [d, n]
    }
  }

  private build(files: DayFile[]): Omit<Footprint, 'days'> {
    const merged = emptyDay('', this.resolution)
    for (const f of files) this.mergeDay(merged, f)
    const cap =
      this.percentile >= 100
        ? undefined
        : percentileNm(merged.distanceBins, this.percentile / 100)
    const cells: Footprint['cells'] = []
    const capped: Footprint['capped'] = []
    for (const [id, [minDistanceNm, reports]] of Object.entries(merged.cells)) {
      if (cap !== undefined && minDistanceNm > cap)
        capped.push({ id, minDistanceNm, reports })
      else cells.push({ id, minDistanceNm, reports })
    }
    return {
      resolution: this.resolution,
      capNm: cap ?? null,
      cells,
      cappedCells: capped.length,
      capped,
      areaKm2: cells.length * getHexagonAreaAvg(this.resolution, 'km2'),
    }
  }
}

export interface CellFeature {
  type: 'Feature'
  id: string
  properties: {
    kind: 'cell'
    id: string
    intensity: number
    reports: number
    /** Metres. */
    minDistanceM: number
    /** Beyond the distance cap; only present when capped cells are included. */
    capped?: true
  }
  geometry: { type: 'Polygon'; coordinates: number[][][] }
}

/**
 * GeoJSON of a footprint, one polygon per cell. `intensity` (0 to 1) is
 * the cell's report count on a log scale relative to the busiest cell.
 * With `includeCapped`, the cells beyond the distance cap follow, marked
 * `capped`.
 */
export function footprintGeoJson(
  f: Footprint,
  includeCapped = false,
): {
  type: 'FeatureCollection'
  features: CellFeature[]
} {
  const list = includeCapped
    ? [...f.cells, ...f.capped.map((c) => ({ ...c, capped: true as const }))]
    : f.cells
  const maxLog = Math.log1p(Math.max(1, ...list.map((c) => c.reports)))
  return {
    type: 'FeatureCollection',
    features: list.map((c) => ({
      type: 'Feature',
      id: c.id,
      properties: {
        kind: 'cell',
        id: c.id,
        intensity: Math.round((Math.log1p(c.reports) / maxLog) * 1000) / 1000,
        reports: c.reports,
        minDistanceM: Math.round(c.minDistanceNm * M_PER_NM),
        ...('capped' in c ? { capped: true as const } : {}),
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          cellToBoundary(c.id, true).map(([lng, lat]) => [
            Math.round(lng * 1e5) / 1e5,
            Math.round(lat * 1e5) / 1e5,
          ]),
        ],
      },
    })),
  }
}
