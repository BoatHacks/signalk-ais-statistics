// The aggregator (ARCHITECTURE 2.4): cumulative counters since start, a
// ring of minute buckets for the rolling one-hour gauges, a ring of hour
// buckets for live-only windows, and the unique vessel registry. Pure and
// clock-injectable: every method takes the reception time.
import {
  classOf,
  isPositionReport,
  isVesselMessage,
  typeGroup,
} from './classify'
import { bearingDeg, distanceNm, sectorOf } from './geo'
import {
  SECTOR_BIN_COUNT,
  addInto,
  binOf,
  emptyBins,
  sectorBinOf,
  sectorPercentileNm,
} from './histogram'
import type { AisMessage } from './ingest'
import type { LatLon } from './ownposition'
import {
  SECTOR_CLASSES,
  SECTOR_COUNT,
  TYPE_GROUPS,
  type TypeGroup,
} from './paths'

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** Upper bound on the vessel registry; oldest entries go first. */
export const MAX_VESSELS = 50_000

export interface Counts {
  messages: number
  positions: { A: number; B: number; other: number }
  distanceBins: number[]
  /** Indexed [class][sector], class order as SECTOR_CLASSES. */
  sectorCounts: number[][]
}

export interface Bucket extends Counts {
  start: number
  maxNm?: number
  /** Coarse histograms, indexed [class][sector][bin]. */
  sectorBins: number[][][]
  vessels: number
  vesselsByGroup: Record<TypeGroup, number>
}

export interface Located {
  mmsi: string
  lat: number
  lon: number
  distanceNm: number
  time: number
}

function emptyCounts(): Counts {
  return {
    messages: 0,
    positions: { A: 0, B: 0, other: 0 },
    distanceBins: emptyBins(),
    sectorCounts: SECTOR_CLASSES.map(() =>
      new Array<number>(SECTOR_COUNT).fill(0),
    ),
  }
}

function emptyGroups(): Record<TypeGroup, number> {
  return Object.fromEntries(TYPE_GROUPS.map((g) => [g, 0])) as Record<
    TypeGroup,
    number
  >
}

export function emptyBucket(start: number): Bucket {
  return {
    ...emptyCounts(),
    start,
    sectorBins: SECTOR_CLASSES.map(() =>
      Array.from({ length: SECTOR_COUNT }, () => emptyBins(SECTOR_BIN_COUNT)),
    ),
    vessels: 0,
    vesselsByGroup: emptyGroups(),
  }
}

/** Adds counts of b into a. Vessel counts are not additive and are left alone. */
export function mergeInto(a: Bucket, b: Bucket): void {
  a.messages += b.messages
  a.positions.A += b.positions.A
  a.positions.B += b.positions.B
  a.positions.other += b.positions.other
  addInto(a.distanceBins, b.distanceBins)
  for (let c = 0; c < SECTOR_CLASSES.length; c++) {
    addInto(a.sectorCounts[c]!, b.sectorCounts[c]!)
    for (let s = 0; s < SECTOR_COUNT; s++)
      addInto(a.sectorBins[c]![s]!, b.sectorBins[c]![s]!)
  }
  if (b.maxNm !== undefined && (a.maxNm === undefined || b.maxNm > a.maxNm))
    a.maxNm = b.maxNm
}

/** p99 per sector for one bucket, indexed [class][sector]. */
export function sectorP99(bucket: Bucket): (number | undefined)[][] {
  return bucket.sectorBins.map((cls) =>
    cls.map((bins) => sectorPercentileNm(bins, 0.99)),
  )
}

const floorTo = (t: number, step: number) => Math.floor(t / step) * step

interface VesselEntry {
  lastSeen: number
  shipType?: number
}

export class Aggregator {
  /** Cumulative counters since the plugin started (SPEC 6.2). */
  readonly totals: Counts = emptyCounts()
  readonly startedAt: number
  private minutes: Bucket[] = []
  private hours: Bucket[] = []
  private openMinute: Bucket
  private openHour: Bucket
  private hourVessels = new Set<string>()
  private vessels = new Map<string, VesselEntry>()
  private lastMessageAt?: number

  constructor(now: number) {
    this.startedAt = now
    this.openMinute = emptyBucket(floorTo(now, MINUTE_MS))
    this.openHour = emptyBucket(floorTo(now, HOUR_MS))
  }

  /**
   * Counts one decoded message received at `time`, with the own position at
   * that time (undefined when unknown or stale). Returns the located
   * position for coverage, when distance could be computed.
   */
  add(
    msg: AisMessage,
    own: LatLon | undefined,
    time: number,
  ): Located | undefined {
    this.roll(time)
    this.lastMessageAt = time
    const cls = classOf(msg.type)
    this.bump((b) => b.messages++)

    if (isVesselMessage(msg.type)) this.seeVessel(msg, time)
    if (!isPositionReport(msg.type)) return undefined

    this.bump((b) => b.positions[cls]++)
    if (msg.lat === undefined || msg.lon === undefined || !own) return undefined

    const target = { lat: msg.lat, lon: msg.lon }
    const d = distanceNm(own, target)
    if (!Number.isFinite(d)) return undefined
    const bin = binOf(d)
    this.bump((b) => b.distanceBins[bin]!++)
    for (const b of [this.openMinute, this.openHour])
      if (b.maxNm === undefined || d > b.maxNm) b.maxNm = d

    const ci = cls === 'A' ? 0 : cls === 'B' ? 1 : -1
    if (ci >= 0) {
      const sector = sectorOf(bearingDeg(own, target))
      this.bump((b) => b.sectorCounts[ci]![sector]!++)
      const sb = sectorBinOf(d)
      for (const b of [this.openMinute, this.openHour])
        b.sectorBins[ci]![sector]![sb]!++
    }
    return { mmsi: msg.mmsi, ...target, distanceNm: d, time }
  }

  /** Closes buckets that ended before `time`. Call at least once a minute. */
  roll(time: number): void {
    const minute = floorTo(time, MINUTE_MS)
    if (minute > this.openMinute.start) {
      this.minutes.push(this.openMinute)
      this.openMinute = emptyBucket(minute)
      const keepFrom = minute - HOUR_MS
      while (this.minutes.length && this.minutes[0]!.start < keepFrom)
        this.minutes.shift()
    }
    const hour = floorTo(time, HOUR_MS)
    if (hour > this.openHour.start) {
      this.closeHour()
      this.openHour = emptyBucket(hour)
      const keepFrom = hour - DAY_MS
      while (this.hours.length && this.hours[0]!.start < keepFrom)
        this.hours.shift()
    }
    this.pruneVessels(time)
  }

  /** Merged bucket of the last hour: closed minutes in range plus the open one. */
  lastHour(time: number): Bucket {
    this.roll(time)
    const from = time - HOUR_MS
    const out = emptyBucket(from)
    for (const m of this.minutes)
      if (m.start + MINUTE_MS > from) mergeInto(out, m)
    mergeInto(out, this.openMinute)
    return out
  }

  /** Closed hour buckets of the last 24 hours plus the open hour, oldest first. */
  hourBuckets(time: number): Bucket[] {
    this.roll(time)
    const open = { ...this.openHour, ...this.vesselCounts(this.hourVessels) }
    return [...this.hours, open]
  }

  /** Closed minute buckets of the last hour plus the open minute, oldest first. */
  minuteBuckets(time: number): Bucket[] {
    this.roll(time)
    return [...this.minutes, this.openMinute]
  }

  /** Unique vessels seen within `windowMs` before `time`, by type group. */
  uniqueVessels(
    time: number,
    windowMs: number,
  ): { total: number; byGroup: Record<TypeGroup, number> } {
    const byGroup = emptyGroups()
    let total = 0
    const from = time - windowMs
    for (const v of this.vessels.values()) {
      if (v.lastSeen < from) continue
      total++
      byGroup[typeGroup(v.shipType)]++
    }
    return { total, byGroup }
  }

  /** Vessels heard within `expiryMs`: the live tracked targets (SPEC 3). */
  trackedTargets(time: number, expiryMs: number): number {
    let n = 0
    for (const v of this.vessels.values())
      if (time - v.lastSeen <= expiryMs) n++
    return n
  }

  lastMessageTime(): number | undefined {
    return this.lastMessageAt
  }

  private bump(f: (c: Counts) => void): void {
    f(this.totals)
    f(this.openMinute)
    f(this.openHour)
  }

  private seeVessel(msg: AisMessage, time: number): void {
    const prev = this.vessels.get(msg.mmsi)
    // Re-insert so the map stays ordered by last seen, oldest first.
    if (prev) this.vessels.delete(msg.mmsi)
    else if (this.vessels.size >= MAX_VESSELS) {
      const oldest = this.vessels.keys().next()
      if (!oldest.done) this.vessels.delete(oldest.value)
    }
    this.vessels.set(msg.mmsi, {
      lastSeen: time,
      shipType: msg.shipType ?? prev?.shipType,
    })
    this.hourVessels.add(msg.mmsi)
  }

  private vesselCounts(
    set: Set<string>,
  ): Pick<Bucket, 'vessels' | 'vesselsByGroup'> {
    const byGroup = emptyGroups()
    for (const mmsi of set)
      byGroup[typeGroup(this.vessels.get(mmsi)?.shipType)]++
    return { vessels: set.size, vesselsByGroup: byGroup }
  }

  private closeHour(): void {
    Object.assign(this.openHour, this.vesselCounts(this.hourVessels))
    this.hours.push(this.openHour)
    this.hourVessels = new Set()
  }

  private pruneVessels(time: number): void {
    const from = time - DAY_MS
    for (const [mmsi, v] of this.vessels) {
      if (v.lastSeen >= from) break
      this.vessels.delete(mmsi)
    }
  }
}
