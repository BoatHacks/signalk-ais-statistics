// Layout of the sector chart: the scale, and per sector the tick from the
// centre out to the farthest reception, ending in a dot. Pure, so it can be
// tested without a DOM.
import type { SectorStats } from './api'

/** Scale room beyond the longest wedge, so the far ticks stay visible. */
export const TICK_ROOM = 1.25

export interface Tick {
  /** Radius of the wedge's edge, in chart units; 0 without a wedge. */
  wedge: number
  /** Radius of the tick's end, in chart units, at most the rim. */
  outer: number
  /** The farthest reception lies beyond the rim; the tick stops there. */
  clipped: boolean
  /** The farthest reception of the whole chart. */
  farthest: boolean
}

export interface SectorLayout {
  /** The distance at the rim, in metres; 0 when there is nothing to draw. */
  max: number
  /** One entry per sector, null when the sector has no reception. */
  ticks: (Tick | null)[]
}

/** The distance at the rim of a chart of its own, in metres. */
export function sectorScale(stats: SectorStats): number {
  const p99 = Math.max(0, ...stats.sectors.map((s) => s.p99M ?? 0))
  const far = Math.max(0, ...stats.sectors.map((s) => s.maxM ?? 0))
  return p99 > 0 ? Math.min(Math.max(p99, far), p99 * TICK_ROOM) : far
}

/**
 * The scale follows the wedges, with up to a quarter more room for the
 * ticks; ticks beyond it stop at the rim. Every sector with a reception
 * gets a tick from the centre, drawn over its wedge, so it shows even when
 * the farthest reception is at the wedge's edge.
 */
export function sectorLayout(
  stats: SectorStats,
  rim: number,
  /** A larger scale in metres, so charts side by side share one. */
  scaleM?: number,
): SectorLayout {
  const far = Math.max(0, ...stats.sectors.map((s) => s.maxM ?? 0))
  const own = sectorScale(stats)
  const max = own > 0 && scaleM !== undefined ? Math.max(own, scaleM) : own
  if (max === 0) return { max, ticks: stats.sectors.map(() => null) }
  const scale = rim / max
  let farthestDone = false
  const ticks = stats.sectors.map((s): Tick | null => {
    if (s.maxM === null || s.maxM <= 0) return null
    const outer = Math.min(rim, s.maxM * scale)
    const farthest = !farthestDone && s.maxM === far
    if (farthest) farthestDone = true
    return {
      wedge: Math.min(outer, (s.p99M ?? 0) * scale),
      outer,
      clipped: s.maxM * scale > rim,
      farthest,
    }
  })
  return { max, ticks }
}
