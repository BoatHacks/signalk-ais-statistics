// Map layer visibility (SPEC 7): the coverage cells, the cells beyond the
// distance cap and the class A and B sectors can each be switched on or off,
// and the choice is remembered per browser.
export type Layer = 'cells' | 'capped' | 'sectorsA' | 'sectorsB'

const key = (l: string) => `signalk-ais-statistics.layer.${l}`

/** Cells beyond the cap start hidden; the other layers start shown. */
const DEFAULTS: Record<Layer, boolean> = {
  cells: true,
  capped: false,
  sectorsA: true,
  sectorsB: true,
}

/**
 * An earlier single "radar" toggle covered both classes; its saved choice
 * stands for each sector layer until that layer is switched itself.
 */
const LEGACY: Partial<Record<Layer, string>> = {
  sectorsA: 'radar',
  sectorsB: 'radar',
}

export function layerVisible(l: Layer): boolean {
  try {
    const legacy = LEGACY[l]
    const v =
      localStorage.getItem(key(l)) ??
      (legacy === undefined ? null : localStorage.getItem(key(legacy)))
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
