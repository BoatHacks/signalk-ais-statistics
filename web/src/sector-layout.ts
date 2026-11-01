// Layout of the sector chart: the scale, and the dot at the chart's
// farthest reception. Pure, so it can be tested without a DOM.
import type { SectorStats } from './api'

/** Scale room beyond the longest wedge, so the farthest dot stays visible. */
export const SCALE_ROOM = 1.25

export interface Farthest {
  /** Index of the sector holding the chart's farthest reception. */
  sector: number
  /** Radius of the dot, in chart units, at most the rim. */
  r: number
  /** The farthest reception lies beyond the rim; the dot sits on it. */
  clipped: boolean
}

export interface SectorLayout {
  /** The distance at the rim, in metres; 0 when there is nothing to draw. */
  max: number
  /** The chart's farthest reception, null without one. */
  farthest: Farthest | null
}

/** The distance at the rim of a chart of its own, in metres. */
export function sectorScale(stats: SectorStats): number {
  const p99 = Math.max(0, ...stats.sectors.map((s) => s.p99M ?? 0))
  const far = Math.max(0, ...stats.sectors.map((s) => s.maxM ?? 0))
  return p99 > 0 ? Math.min(Math.max(p99, far), p99 * SCALE_ROOM) : far
}

/**
 * The scale follows the wedges, with up to a quarter more room for the
 * farthest reception; a farthest reception beyond it sits on the rim. Only
 * the sector with the chart's farthest reception gets a dot, the first one
 * when two sectors tie.
 */
export function sectorLayout(
  stats: SectorStats,
  rim: number,
  /** A larger scale in metres, so charts side by side share one. */
  scaleM?: number,
): SectorLayout {
  const own = sectorScale(stats)
  const max = own > 0 && scaleM !== undefined ? Math.max(own, scaleM) : own
  if (max === 0) return { max, farthest: null }
  const far = Math.max(0, ...stats.sectors.map((s) => s.maxM ?? 0))
  const i = stats.sectors.findIndex((s) => s.maxM !== null && s.maxM === far)
  if (far <= 0 || i < 0) return { max, farthest: null }
  const r = (far / max) * rim
  return {
    max,
    farthest: { sector: i, r: Math.min(rim, r), clipped: r > rim },
  }
}
