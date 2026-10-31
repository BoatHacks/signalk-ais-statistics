// Client for the plugin's REST API (SPEC 6.1).
export const API = '/plugins/signalk-ais-statistics'

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
}

export interface Radar {
  source: 'history' | 'live'
  /** Set when history failed and the answer fell back to live data. */
  historyError?: string
  sectors: {
    sector: number
    fromDeg: number
    toDeg: number
    count: number
    p99M: number | null
  }[]
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
