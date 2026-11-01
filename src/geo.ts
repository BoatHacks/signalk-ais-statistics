// Great-circle helpers (SPEC 2.2). Distances in nautical miles, bearings in
// degrees true.
import { SECTOR_COUNT, SECTOR_WIDTH_DEG } from './paths'
import type { LatLon } from './ownposition'

/** Mean Earth radius in nautical miles. */
export const EARTH_RADIUS_NM = 3440.065

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export function distanceNm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial true bearing from a to b, in [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = rad(a.lat)
  const φ2 = rad(b.lat)
  const dλ = rad(b.lon - a.lon)
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

/** Sector index 0 to 23 for a bearing; sector 0 covers [0, 15). */
export function sectorOf(bearing: number): number {
  const b = ((bearing % 360) + 360) % 360
  return Math.min(SECTOR_COUNT - 1, Math.floor(b / SECTOR_WIDTH_DEG))
}

/** Destination point from a start, bearing and distance (used by tests and the sector polygons). */
export function destination(
  from: LatLon,
  bearing: number,
  distance: number,
): LatLon {
  const δ = distance / EARTH_RADIUS_NM
  const θ = rad(bearing)
  const φ1 = rad(from.lat)
  const λ1 = rad(from.lon)
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  )
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    )
  return { lat: deg(φ2), lon: ((deg(λ2) + 540) % 360) - 180 }
}

/** Metres per nautical mile. Statistics are kept in nm and served in SI. */
export const M_PER_NM = 1852
