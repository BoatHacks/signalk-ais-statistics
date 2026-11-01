// Long-range log (SPEC 2.7 and 8): per UTC day, the farthest reception of
// each vessel, capped at the farthest MAX_PER_DAY. It keeps what history
// cannot: when, from where and from whom a far position was received, so a
// propagation event can be told from a bogus position. Each day lives in a
// small JSON file beside the coverage files.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { DAY_MS, type Located, type VesselInfo } from './aggregate'
import { utcDay } from './coverage'
import { M_PER_NM } from './geo'

/** Entries kept per UTC day. */
export const MAX_PER_DAY = 50
const FILE_VERSION = 1
const FILE_RE = /^longrange-(\d{4}-\d{2}-\d{2})\.json$/

export interface LongRangeEntry {
  /** Reception time, ISO 8601. */
  time: string
  mmsi: string
  name?: string
  cls: 'A' | 'B' | 'other'
  shipType?: number
  /** Metres. */
  distanceM: number
  bearingDeg: number
  lat: number
  lon: number
  ownLat: number
  ownLon: number
}

interface DayFile {
  version: number
  date: string
  entries: LongRangeEntry[]
}

const round = (x: number, f: number) => Math.round(x * f) / f

function isEntry(x: unknown): x is LongRangeEntry {
  const e = x as LongRangeEntry
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.time === 'string' &&
    typeof e.mmsi === 'string' &&
    typeof e.distanceM === 'number' &&
    typeof e.bearingDeg === 'number' &&
    typeof e.lat === 'number' &&
    typeof e.lon === 'number' &&
    typeof e.ownLat === 'number' &&
    typeof e.ownLon === 'number'
  )
}

export class LongRangeLog {
  private date: string
  /** Today's entries by MMSI. */
  private today = new Map<string, LongRangeEntry>()
  /** Earlier days, read from their files on first use. */
  private days = new Map<string, LongRangeEntry[]>()
  private dirty = false
  /** Writes run one after another, so two never share a temporary file. */
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly retentionDays: number,
    now: number,
  ) {
    this.date = utcDay(now)
  }

  private file(date: string): string {
    return join(this.dir, `longrange-${date}.json`)
  }

  /** Loads today's file so a restart continues the day. */
  async load(now: number): Promise<void> {
    const date = utcDay(now)
    const entries = await this.read(date)
    if (this.date !== date) return
    for (const e of entries) this.keep(e)
  }

  /** Offers one located report; keeps it if it is among the day's farthest. */
  add(located: Located, vessel: VesselInfo): void {
    const date = utcDay(located.time)
    if (date !== this.date) {
      // The day changed: write the finished day, start the next one.
      const finished = this.date
      const entries = [...this.today.values()]
      void this.write(finished, entries).catch(() => undefined)
      this.days.set(finished, entries)
      this.today = new Map()
      this.date = date
    }
    const distanceM = Math.round(located.distanceNm * M_PER_NM)
    const prev = this.today.get(located.mmsi)
    if (prev && prev.distanceM >= distanceM) {
      if (!prev.name && vessel.name) {
        prev.name = vessel.name
        this.dirty = true
      }
      return
    }
    const entry: LongRangeEntry = {
      time: new Date(located.time).toISOString(),
      mmsi: located.mmsi,
      cls: located.cls,
      distanceM,
      bearingDeg: round(located.bearingDeg, 10),
      lat: round(located.lat, 1e5),
      lon: round(located.lon, 1e5),
      ownLat: round(located.own.lat, 1e5),
      ownLon: round(located.own.lon, 1e5),
    }
    const name = vessel.name ?? prev?.name
    if (name) entry.name = name
    const shipType = vessel.shipType ?? prev?.shipType
    if (shipType !== undefined) entry.shipType = shipType
    this.keep(entry)
  }

  /** Fills in names learnt after an entry was made. */
  enrich(lookup: (mmsi: string) => VesselInfo): void {
    for (const e of this.today.values()) {
      if (e.name) continue
      const name = lookup(e.mmsi).name
      if (name) {
        e.name = name
        this.dirty = true
      }
    }
  }

  /** The farthest entries received in [from, to), farthest first. */
  async entries(
    from: number,
    to: number,
    limit: number,
  ): Promise<LongRangeEntry[]> {
    const all: LongRangeEntry[] = []
    for (let t = from; utcDay(t) <= utcDay(to - 1); t += DAY_MS) {
      const date = utcDay(t)
      all.push(
        ...(date === this.date ? this.today.values() : await this.day(date)),
      )
    }
    return all
      .filter((e) => {
        const t = Date.parse(e.time)
        return t >= from && t < to
      })
      .sort((a, b) => b.distanceM - a.distanceM)
      .slice(0, limit)
  }

  /** Writes today's file if it changed. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await this.write(this.date, [...this.today.values()])
  }

  /** Deletes day files older than the retention period. */
  async prune(now: number): Promise<string[]> {
    const oldest = utcDay(now - (this.retentionDays - 1) * DAY_MS)
    for (const date of this.days.keys())
      if (date < oldest) this.days.delete(date)
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

  private keep(entry: LongRangeEntry): void {
    const prev = this.today.get(entry.mmsi)
    if (prev && prev.distanceM >= entry.distanceM) return
    if (!prev && this.today.size >= MAX_PER_DAY) {
      let nearest: LongRangeEntry | undefined
      for (const e of this.today.values())
        if (!nearest || e.distanceM < nearest.distanceM) nearest = e
      if (!nearest || nearest.distanceM >= entry.distanceM) return
      this.today.delete(nearest.mmsi)
    }
    this.today.set(entry.mmsi, entry)
    this.dirty = true
  }

  private async day(date: string): Promise<LongRangeEntry[]> {
    const cached = this.days.get(date)
    if (cached) return cached
    const entries = await this.read(date)
    this.days.set(date, entries)
    return entries
  }

  private async read(date: string): Promise<LongRangeEntry[]> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.file(date), 'utf8'),
      ) as Partial<DayFile>
      return Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : []
    } catch {
      return []
    }
  }

  private write(date: string, entries: LongRangeEntry[]): Promise<void> {
    const run = this.writing.then(async () => {
      await fs.mkdir(this.dir, { recursive: true })
      const target = this.file(date)
      const tmp = `${target}.tmp`
      const file: DayFile = { version: FILE_VERSION, date, entries }
      await fs.writeFile(tmp, JSON.stringify(file))
      await fs.rename(tmp, target)
    })
    this.writing = run.catch(() => undefined)
    return run
  }
}
