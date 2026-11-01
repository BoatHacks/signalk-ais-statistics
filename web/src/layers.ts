// Map layer visibility (SPEC 7): the coverage cells, the cells beyond the
// distance cap and the radar can each be switched on or off, and the choice
// is remembered per browser.
export type Layer = 'cells' | 'capped' | 'radar'

const key = (l: Layer) => `signalk-ais-statistics.layer.${l}`

/** Cells beyond the cap start hidden; the other layers start shown. */
const DEFAULTS: Record<Layer, boolean> = {
  cells: true,
  capped: false,
  radar: true,
}

export function layerVisible(l: Layer): boolean {
  try {
    const v = localStorage.getItem(key(l))
    return v === null ? DEFAULTS[l] : v === 'on'
  } catch {
    return DEFAULTS[l]
  }
}

export function saveLayerVisible(l: Layer, on: boolean): void {
  try {
    localStorage.setItem(key(l), on ? 'on' : 'off')
  } catch {
    // storage unavailable, the choice lasts for this page only
  }
}
