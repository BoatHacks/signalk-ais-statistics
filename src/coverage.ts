// Coverage (ARCHITECTURE 2.5, SPEC 2.4 and 8): the H3 cells that contained
// at least one target position, per UTC day. Each day lives in a small JSON
// file in the plugin data directory with, per own vessel mode and cell, the
// shortest distance and the number of reports seen there, plus the day's
// distance histogram over all modes.
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
import { MODES, type Mode } from './mode'

/**
 * A cell beyond the distance cap stays in the footprint with at least this
 * many reports: repeated reports from one far cell are real reception, a
 * single bogus position almost never repeats (SPEC 2.4).
 */
export const MIN_FAR_CELL_REPORTS = 3
import { DISTANCE_BIN_COUNT } from './paths'

/**
 * Upper bound on cells kept for one day. A cell seen in two modes counts
 * twice.
 */
export const MAX_CELLS_PER_DAY = 20_000
/**
 * Version 2 keeps cells per mode. Version 1 files (one `cells` map) are
 * still read, with their cells under `unknown`.
 */
const FILE_VERSION = 2

/** [shortest distance in nm, number of reports] */
type CellStats = [number, number]
type CellMap = Record<string, CellStats>

export interface DayFile {
  version: number
  date: string
  resolution: number
  modes: Record<Mode, CellMap>
  distanceBins: number[]
}

/** Which cells a footprint shows: every mode, or one. */
export const COVERAGE_MODES = ['all', 'stationary', 'underway'] as const
export type CoverageMode = (typeof COVERAGE_MODES)[number]

export interface Footprint {
  days: string[]
  mode: CoverageMode
  resolution: number
  /** Distance cap applied, or null when the cap is disabled or there is no data. */
  capNm: number | null
  cells: { id: string; minDistanceNm: number; reports: number }[]
  /** Sparse cells beyond the cap, left out. */
  cappedCells: number
  /** The cells left out, for views that show them anyway. */
  capped: { id: string; minDistanceNm: number; reports: number }[]
  areaKm2: number
}

export function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

const FILE_RE = /^coverage-(\d{4}-\d{2}-\d{2})\.json$/

const emptyModes = (): Record<Mode, CellMap> => ({
  stationary: {},
  underway: {},
  unknown: {},
})

function emptyDay(date: string, resolution: number): DayFile {
  return {
    version: FILE_VERSION,
    date,
    resolution,
    modes: emptyModes(),
    distanceBins: emptyBins(),
  }
}

const isMap = (x: unknown): x is CellMap =>
  !!x && typeof x === 'object' && !Array.isArray(x)

/**
 * A parsed day file in the version 2 shape, or undefined when it is not
 * one. Version 1 cells move to `unknown`; a mode entry that is not a cell
 * map is left empty.
 */
function toDayFile(x: unknown): DayFile | undefined {
  if (!x || typeof x !== 'object') return undefined
  const d = x as Record<string, unknown>
  if (
    typeof d.date !== 'string' ||
    typeof d.resolution !== 'number' ||
    !Array.isArray(d.distanceBins) ||
    d.distanceBins.length !== DISTANCE_BIN_COUNT
  )
    return undefined
  const modes = emptyModes()
  if (d.version === 1 || d.version === undefined) {
    if (!isMap(d.cells)) return undefined
    modes.unknown = d.cells
  } else if (d.version === FILE_VERSION) {
    if (!isMap(d.modes)) return undefined
    const from = d.modes as Record<string, unknown>
    for (const m of MODES) if (isMap(from[m])) modes[m] = from[m]
  } else return undefined
  return {
    version: FILE_VERSION,
    date: d.date,
    resolution: d.resolution,
    modes,
    distanceBins: d.distanceBins as number[],
  }
}

const cellCount = (day: DayFile): number =>
  MODES.reduce((n, m) => n + Object.keys(day.modes[m]).length, 0)

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
  /** Mode and cell pairs in the current day. */
  private cellsInDay = 0
  private dirty = false
  droppedCells = 0

  constructor(
    private readonly dir: string,
    private readonly resolution: number,
    private readonly retentionDays: number,
    private percentile: number,
    now: number,
  ) {
    this.day = emptyDay(utcDay(now), resolution)
  }

  private file(date: string): string {
    return join(this.dir, `coverage-${date}.json`)
  }

  /** Changes the distance cap percentile, for example after a saved setting. */
  setPercentile(percentile: number): void {
    this.percentile = percentile
  }

  /** The configured distance cap percentile. */
  capPercentile(): number {
    return this.percentile
  }

  /** Loads today's file so a restart continues the day. */
  async load(now: number): Promise<void> {
    const date = utcDay(now)
    const existing = await this.read(date)
    // Reports may have arrived while the file was read; merge, do not replace.
    if (existing && this.day.date === date) {
      this.mergeDay(this.day, existing)
      this.cellsInDay = cellCount(this.day)
      this.dirty = true
    }
  }

  /** Records one located report, under the own vessel mode at reception. */
  add(
    lat: number,
    lon: number,
    distanceNm: number,
    time: number,
    mode: Mode = 'unknown',
  ): void {
    const date = utcDay(time)
    if (date !== this.day.date) {
      // The day changed: write the finished day, start the next one.
      void this.flush().catch(() => undefined)
      this.day = emptyDay(date, this.resolution)
      this.cellsInDay = 0
    }
    let id: string
    try {
      id = latLngToCell(lat, lon, this.resolution)
    } catch {
      return
    }
    this.day.distanceBins[binOf(distanceNm)]!++
    const cells = this.day.modes[mode]
    const c = cells[id]
    if (c) {
      c[0] = Math.min(c[0], distanceNm)
      c[1]++
    } else if (this.cellsInDay < MAX_CELLS_PER_DAY) {
      cells[id] = [distanceNm, 1]
      this.cellsInDay++
    } else {
      this.droppedCells++
    }
    this.dirty = true
  }

  /**
   * Cell count and area for the current day over all modes, with the
   * percentile cap.
   */
  today(now: number): { cells: number; areaKm2: number } {
    const f = this.build([this.currentDay(now)], this.percentile, 'all')
    return { cells: f.cells.length, areaKm2: f.areaKm2 }
  }

  /**
   * Union of the last `days` UTC days, today included. `percentile`
   * overrides the configured cap for this answer only, so the web app can
   * try a value before saving it. `mode` picks the cells of one own vessel
   * mode; the cap always comes from the distances of all modes, so a mode's
   * footprint is a subset of the combined one.
   */
  async footprint(
    days: number,
    now: number,
    percentile = this.percentile,
    mode: CoverageMode = 'all',
  ): Promise<Footprint> {
    const dates: string[] = []
    for (let i = days - 1; i >= 0; i--) dates.push(utcDay(now - i * DAY_MS))
    return this.footprintOf(dates, now, percentile, mode)
  }

  /**
   * Union of the UTC days `from` to `to`, both included, read from the day
   * files only. Days after today have no file and are left out.
   */
  async footprintRange(
    from: string,
    to: string,
    now: number,
    percentile = this.percentile,
    mode: CoverageMode = 'all',
  ): Promise<Footprint> {
    const today = utcDay(now)
    const dates: string[] = []
    for (
      let t = Date.parse(from);
      utcDay(t) <= to && utcDay(t) <= today;
      t += DAY_MS
    )
      dates.push(utcDay(t))
    return this.footprintOf(dates, now, percentile, mode)
  }

  /** The oldest UTC day the files are kept for. */
  retainedFrom(now: number): string {
    return utcDay(now - (this.retentionDays - 1) * DAY_MS)
  }

  private async footprintOf(
    dates: string[],
    now: number,
    percentile: number,
    mode: CoverageMode,
  ): Promise<Footprint> {
    const today = utcDay(now)
    const files: DayFile[] = []
    for (const date of dates) {
      if (date === today) files.push(this.currentDay(now))
      else {
        const f = await this.read(date)
        if (f) files.push(f)
      }
    }
    return { ...this.build(files, percentile, mode), days: dates }
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
    const oldest = this.retainedFrom(now)
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
      return toDayFile(parsed)
    } catch {
      return undefined
    }
  }

  private mergeDay(into: DayFile, from: DayFile): void {
    addInto(into.distanceBins, from.distanceBins)
    for (const m of MODES)
      mergeCells(into.modes[m], from.modes[m], into.resolution)
  }

  private build(
    files: DayFile[],
    percentile: number,
    mode: CoverageMode,
  ): Omit<Footprint, 'days'> {
    const merged = emptyDay('', this.resolution)
    for (const f of files) this.mergeDay(merged, f)
    const cap =
      percentile >= 100
        ? undefined
        : percentileNm(merged.distanceBins, percentile / 100)
    // One map of the modes shown; a cell seen in several modes is one cell.
    const shown: CellMap = {}
    for (const m of mode === 'all' ? MODES : [mode])
      mergeCells(shown, merged.modes[m], this.resolution)
    const cells: Footprint['cells'] = []
    const capped: Footprint['capped'] = []
    for (const [id, [minDistanceNm, reports]] of Object.entries(shown)) {
      if (
        cap !== undefined &&
        minDistanceNm > cap &&
        reports < MIN_FAR_CELL_REPORTS
      )
        capped.push({ id, minDistanceNm, reports })
      else cells.push({ id, minDistanceNm, reports })
    }
    return {
      mode,
      resolution: this.resolution,
      capNm: cap ?? null,
      cells,
      cappedCells: capped.length,
      capped,
      areaKm2: cells.length * getHexagonAreaAvg(this.resolution, 'km2'),
    }
  }
}

/** Adds the valid cells of `from` into `into`, at `resolution`. */
function mergeCells(into: CellMap, from: CellMap, resolution: number): void {
  for (const [raw, stats] of Object.entries(from)) {
    if (!Array.isArray(stats)) continue
    const [d, n] = stats
    if (typeof d !== 'number' || typeof n !== 'number') continue
    const id = atResolution(raw, resolution)
    if (!id) continue
    const c = into[id]
    if (c) {
      c[0] = Math.min(c[0], d)
      c[1] += n
    } else into[id] = [d, n]
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
