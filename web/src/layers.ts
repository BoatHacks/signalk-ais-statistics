// Map layer visibility (SPEC 7): the coverage cells and the radar can each
// be switched off, and the choice is remembered per browser.
export type Layer = 'cells' | 'radar'

const key = (l: Layer) => `signalk-ais-statistics.layer.${l}`

/** Both layers are shown unless switched off in this browser. */
export function layerVisible(l: Layer): boolean {
  try {
    return localStorage.getItem(key(l)) !== 'off'
  } catch {
    return true
  }
}

export function saveLayerVisible(l: Layer, on: boolean): void {
  try {
    localStorage.setItem(key(l), on ? 'on' : 'off')
  } catch {
    // storage unavailable, the choice lasts for this page only
  }
}
