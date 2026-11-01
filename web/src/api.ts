// Client for the plugin's REST API (SPEC 6.1).
/// <reference types="geojson" />
export const API = '/plugins/signalk-ais-statistics'

import type { Health } from './health'
import type { WindowName } from './route'
export type { WindowName }

export interface Distance {
  count: number
  /** Distances are in metres throughout the API. */
  avgM: number | null
  medianM: number | null
  p95M: number | null
  p99M: number | null
  maxM: number | null
}

export interface Summary {
  window: WindowName
  source: 'history' | 'live'
  /** Set when history failed and the answer fell back to live data. */
  historyError?: string
  messages: number
  positions: { classA: number; classB: number; other: number }
  vessels: { total: number; byGroup: Record<string, number> } | null
  distance: Distance
  health: Health
}

export interface SectorStats {
  source: 'history' | 'live'
  /** Set when history failed and the answer fell back to live data. */
  historyError?: string
  sectors: {
    sector: number
    fromDeg: number
    toDeg: number
    count: number
    p99M: number | null
    /** Farthest reception, untrusted. */
    maxM: number | null
    maxAt: string | null
    /** Start of the hour of the farthest reception, when the exact time is unknown. */
    maxHour: string | null
  }[]
}

export interface LongRangeEntry {
  time: string
  mmsi: string
  name?: string
  cls: 'A' | 'B' | 'other'
  shipType?: number
  distanceM: number
  bearingDeg: number
  lat: number
  lon: number
  ownLat: number
  ownLon: number
}

/** The highest implied speed of one sender on one day. */
export interface FastEntry {
  time: string
  mmsi: string
  name?: string
  cls: 'A' | 'B' | 'other'
  shipType?: number
  /** Speeds in m/s throughout the API. */
  speedMps: number
  sogMps?: number
  limitMps: number
  implausible: boolean
  gapS: number
  fromLat: number
  fromLon: number
  lat: number
  lon: number
}

export interface LongRange {
  entries: LongRangeEntry[]
  /** Plausible speeds, fastest first. */
  fastest: FastEntry[]
  /** Speeds above the sender's limit, fastest first. */
  implausibleJumps: FastEntry[]
}

export interface Series {
  source: 'history' | 'live'
  /** Set when history failed and the answer fell back to live data. */
  historyError?: string
  resolution: number
  times: string[]
  [column: string]: unknown
}

export interface CoverageResponse {
  cells: number
  cappedCells: number
  capM: number | null
  /** The distance cap percentile applied to this answer. */
  capPercentile: number
  areaM2: number
  geojson: GeoJSON.FeatureCollection
}

export interface Status {
  running: boolean
  noData?: boolean
  lastMessageAt?: string | null
  trackedTargets?: number
  ownPositionFresh?: boolean
  historyAvailable?: boolean
  decodeErrors?: number
  /** The effective plugin settings. */
  config?: Record<string, unknown>
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function get<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${API}${path}${qs ? `?${qs}` : ''}`, {
    credentials: 'same-origin',
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg
    } catch {
      // not JSON
    }
    throw new HttpError(res.status, msg)
  }
  return (await res.json()) as T
}
