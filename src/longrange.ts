// Long-range log (SPEC 2.7, 2.8 and 8): per UTC day, the farthest reception
// of each vessel, capped at the farthest MAX_PER_DAY, and the highest
// implied speed of each sender, capped at the fastest MAX_FASTEST_PER_DAY.
// It keeps what history cannot: when, from where and from whom a far
// position or a fast jump was received, so a propagation event or a fast
// craft can be told from a bogus position. Each day lives in a small JSON
// file beside the coverage files.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { DAY_MS, type Located, type VesselInfo } from './aggregate'
import { classOf } from './classify'
import { utcDay } from './coverage'
import { M_PER_NM } from './geo'
import type { SpeedSample } from './health'

/** Entries kept per UTC day. */
export const MAX_PER_DAY = 50
/** Fastest senders kept per UTC day. */
export const MAX_FASTEST_PER_DAY = 20
/** Version 2 adds `fastest`; version 1 files load with an empty list. */
const FILE_VERSION = 2
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

/** The highest implied speed of one sender on one day (SPEC 2.8). */
export interface FastEntry {
  /** Reception time of the later position, ISO 8601. */
  time: string
  mmsi: string
  name?: string
  cls: 'A' | 'B' | 'other'
  shipType?: number
  /** Implied speed between the two positions, m/s. */
  speedMps: number
  /** Speed over ground reported with the later position, m/s. */
  sogMps?: number
  /** The jump limit that applied to this sender, m/s. */
  limitMps: number
  /** The implied speed is above the limit: likely a bogus position. */
  implausible: boolean
  /** Seconds between the two positions. */
  gapS: number
  fromLat: number
  fromLon: number
  lat: number
  lon: number
}

interface DayFile {
  version: number
  date: string
  entries: LongRangeEntry[]
  fastest?: FastEntry[]
}

interface Day {
  entries: LongRangeEntry[]
  fastest: FastEntry[]
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

function isFastEntry(x: unknown): x is FastEntry {
  const e = x as FastEntry
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.time === 'string' &&
    typeof e.mmsi === 'string' &&
    typeof e.speedMps === 'number' &&
    typeof e.limitMps === 'number' &&
    typeof e.implausible === 'boolean' &&
    typeof e.gapS === 'number' &&
    typeof e.fromLat === 'number' &&
    typeof e.fromLon === 'number' &&
    typeof e.lat === 'number' &&
    typeof e.lon === 'number'
  )
}

const inRange = (time: string, from: number, to: number) => {
  const t = Date.parse(time)
  return t >= from && t < to
}

export class LongRangeLog {
  private date: string
  /** Today's entries by MMSI. */
  private today = new Map<string, LongRangeEntry>()
  /** Today's fastest senders by MMSI. */
  private todayFast = new Map<string, FastEntry>()
  /** Earlier days, read from their files on first use. */
  private days = new Map<string, Day>()
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
    const day = await this.read(date)
    if (this.date !== date) return
    for (const e of day.entries) this.keep(e)
    for (const e of day.fastest) this.keepFast(e)
  }

  /** Writes the finished day and starts the next one when the day changed. */
  private roll(time: number): void {
    const date = utcDay(time)
    if (date === this.date) return
    const finished = this.date
    const day = this.snapshot()
    void this.write(finished, day).catch(() => undefined)
    this.days.set(finished, day)
    this.today = new Map()
    this.todayFast = new Map()
    this.date = date
  }

  private snapshot(): Day {
    return {
      entries: [...this.today.values()],
      fastest: [...this.todayFast.values()],
    }
  }

  /** Offers one located report; keeps it if it is among the day's farthest. */
  add(located: Located, vessel: VesselInfo): void {
    this.roll(located.time)
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

  /** Offers one implied speed; keeps it if it is among the day's fastest. */
  addSpeed(sample: SpeedSample, vessel: VesselInfo): void {
    this.roll(sample.time)
    const prev = this.todayFast.get(sample.mmsi)
    if (prev && prev.speedMps >= sample.speedMps) {
      if (!prev.name && vessel.name) {
        prev.name = vessel.name
        this.dirty = true
      }
      return
    }
    const entry: FastEntry = {
      time: new Date(sample.time).toISOString(),
      mmsi: sample.mmsi,
      cls: classOf(sample.messageType),
      speedMps: round(sample.speedMps, 100),
      limitMps: round(sample.limitMps, 100),
      implausible: sample.implausible,
      gapS: round(sample.gapS, 10),
      fromLat: round(sample.fromLat, 1e5),
      fromLon: round(sample.fromLon, 1e5),
      lat: round(sample.lat, 1e5),
      lon: round(sample.lon, 1e5),
    }
    if (sample.sogMps !== undefined) entry.sogMps = round(sample.sogMps, 100)
    const name = vessel.name ?? prev?.name
    if (name) entry.name = name
    const shipType = vessel.shipType ?? prev?.shipType
    if (shipType !== undefined) entry.shipType = shipType
    this.keepFast(entry)
  }

  /** Fills in names learnt after an entry was made. */
  enrich(lookup: (mmsi: string) => VesselInfo): void {
    for (const e of [...this.today.values(), ...this.todayFast.values()]) {
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
    for (const day of await this.range(from, to)) all.push(...day.entries)
    return all
      .filter((e) => inRange(e.time, from, to))
      .sort((a, b) => b.distanceM - a.distanceM)
      .slice(0, limit)
  }

  /**
   * The fastest senders in [from, to), fastest first, one entry per MMSI
   * (its highest speed in the range).
   */
  async fastest(from: number, to: number, limit: number): Promise<FastEntry[]> {
    const best = new Map<string, FastEntry>()
    for (const day of await this.range(from, to))
      for (const e of day.fastest) {
        if (!inRange(e.time, from, to)) continue
        const prev = best.get(e.mmsi)
        if (!prev || e.speedMps > prev.speedMps) best.set(e.mmsi, e)
      }
    return [...best.values()]
      .sort((a, b) => b.speedMps - a.speedMps)
      .slice(0, limit)
  }

  private async range(from: number, to: number): Promise<Day[]> {
    const out: Day[] = []
    for (let t = from; utcDay(t) <= utcDay(to - 1); t += DAY_MS) {
      const date = utcDay(t)
      out.push(date === this.date ? this.snapshot() : await this.day(date))
    }
    return out
  }

  /** Writes today's file if it changed. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await this.write(this.date, this.snapshot())
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

  private keepFast(entry: FastEntry): void {
    const prev = this.todayFast.get(entry.mmsi)
    if (prev && prev.speedMps >= entry.speedMps) return
    if (!prev && this.todayFast.size >= MAX_FASTEST_PER_DAY) {
      let slowest: FastEntry | undefined
      for (const e of this.todayFast.values())
        if (!slowest || e.speedMps < slowest.speedMps) slowest = e
      if (!slowest || slowest.speedMps >= entry.speedMps) return
      this.todayFast.delete(slowest.mmsi)
    }
    this.todayFast.set(entry.mmsi, entry)
    this.dirty = true
  }

  private async day(date: string): Promise<Day> {
    const cached = this.days.get(date)
    if (cached) return cached
    const day = await this.read(date)
    this.days.set(date, day)
    return day
  }

  private async read(date: string): Promise<Day> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.file(date), 'utf8'),
      ) as Partial<DayFile>
      return {
        entries: Array.isArray(parsed.entries)
          ? parsed.entries.filter(isEntry)
          : [],
        fastest: Array.isArray(parsed.fastest)
          ? parsed.fastest.filter(isFastEntry)
          : [],
      }
    } catch {
      return { entries: [], fastest: [] }
    }
  }

  private write(date: string, day: Day): Promise<void> {
    const run = this.writing.then(async () => {
      await fs.mkdir(this.dir, { recursive: true })
      const target = this.file(date)
      const tmp = `${target}.tmp`
      const file: DayFile = { version: FILE_VERSION, date, ...day }
      await fs.writeFile(tmp, JSON.stringify(file))
      await fs.rename(tmp, target)
    })
    this.writing = run.catch(() => undefined)
    return run
  }
}
