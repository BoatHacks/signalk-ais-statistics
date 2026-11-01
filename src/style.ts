// Coverage and radar colours, shared by the plotter overlay and the web
// app map so both draw the footprint the same way. Magenta to purple stands
// out from both chart water and land; a blue ramp disappears over the sea.

/** Cell colour at coverage intensity 0 and 1. */
export const CELL_LOW = '#f768a1'
export const CELL_HIGH = '#7a0177'
export const CELL_FILL_OPACITY = 0.45
export const CELL_LINE_WIDTH = 1

export const RADAR_COLOUR = '#d94801'
export const RADAR_LINE_WIDTH = 1.5
/** The farthest reception per sector: a thin tick beyond the wedge. */
export const RADAR_MAX_LINE_WIDTH = 1

/** Overlay opacity the plotter applies on top of the layer paint. */
export const OVERLAY_OPACITY = 0.8

/**
 * The cell colour for an intensity from 0 to 1, interpolated linearly in
 * RGB as a MapLibre `interpolate` expression does.
 */
export function cellColour(intensity: number): string {
  const t = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0))
  const a = rgb(CELL_LOW)
  const b = rgb(CELL_HIGH)
  return (
    '#' +
    a
      .map((v, i) => Math.round(v + (b[i]! - v) * t))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
}
