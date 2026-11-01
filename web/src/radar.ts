// Bearing radar: one wedge per 15 degree sector, radius the sector's p99
// distance, north up, and a thin tick along each sector's centre out to its
// farthest reception. Built once; updates move the wedges and ticks and
// relabel the rings.
import type { Radar } from './api'
import { el, svg } from './format'
import { maxTime } from './time'
import type { Unit } from './units'

const SIZE = 320
const C = SIZE / 2
const R = C - 28
const RINGS = [0.25, 0.5, 0.75, 1]
/** Scale room beyond the longest wedge, so the far ticks stay visible. */
const TICK_ROOM = 1.25

function point(bearing: number, r: number): [number, number] {
  const a = ((bearing - 90) * Math.PI) / 180
  return [C + r * Math.cos(a), C + r * Math.sin(a)]
}

export class RadarChart {
  readonly element: HTMLElement
  private readonly root: SVGSVGElement
  private readonly ringLabels: SVGTextElement[] = []
  private readonly wedges: SVGPathElement[] = []
  private readonly ticks: SVGLineElement[] = []
  private readonly tickHits: SVGLineElement[] = []
  private readonly tip: HTMLElement
  private readonly empty: HTMLElement
  private data:
    { radar: Radar; unit: Unit; offsetMin: number | undefined } | undefined

  constructor(color: string) {
    this.element = el('div', { class: 'radar-wrap' })
    this.root = svg('svg', {
      viewBox: `0 0 ${SIZE} ${SIZE}`,
      class: 'radar',
      role: 'img',
    })
    for (const f of RINGS) {
      this.root.append(svg('circle', { cx: C, cy: C, r: R * f, class: 'grid' }))
      // Ring labels sit between the north-east sectors to stay readable.
      const [lx, ly] = point(45, R * f)
      const t = svg('text', { x: lx + 2, y: ly - 2, class: 'axis' })
      this.ringLabels.push(t)
      this.root.append(t)
    }
    for (const [label, b] of [
      ['N', 0],
      ['E', 90],
      ['S', 180],
      ['W', 270],
    ] as const) {
      const [x, y] = point(b, R + 14)
      this.root.append(
        svg(
          'text',
          { x, y: y + 4, class: 'axis', 'text-anchor': 'middle' },
          label,
        ),
      )
    }
    this.tip = el('div', { class: 'tip', hidden: '' })
    for (let s = 0; s < 24; s++) {
      const w = svg('path', { fill: color, class: 'wedge' })
      w.addEventListener('pointerenter', () => this.show(s))
      w.addEventListener('pointerleave', () => (this.tip.hidden = true))
      this.wedges.push(w)
      this.root.append(w)
    }
    for (let s = 0; s < 24; s++) {
      const t = svg('line', { stroke: color, class: 'tick' })
      // A wide invisible line over the thin tick makes it easy to hover.
      const hit = svg('line', { class: 'tick-hit' })
      hit.addEventListener('pointerenter', () => this.showMax(s))
      hit.addEventListener('pointerleave', () => (this.tip.hidden = true))
      this.ticks.push(t)
      this.tickHits.push(hit)
      this.root.append(t, hit)
    }
    this.empty = el(
      'p',
      { class: 'muted empty' },
      'No positions with a known own position in this window yet.',
    )
    this.element.append(this.root, this.tip, this.empty)
  }

  update(radar: Radar, unit: Unit, offsetMin?: number): void {
    this.data = { radar, unit, offsetMin }
    // The scale follows the wedges, with up to a quarter more room for the
    // ticks; ticks beyond it stop at the rim.
    const p99 = Math.max(0, ...radar.sectors.map((s) => s.p99M ?? 0))
    const far = Math.max(0, ...radar.sectors.map((s) => s.maxM ?? 0))
    const max = p99 > 0 ? Math.min(Math.max(p99, far), p99 * TICK_ROOM) : far
    this.empty.hidden = max > 0
    this.root.style.visibility = max > 0 ? 'visible' : 'hidden'
    if (max === 0) return
    const scale = R / max
    this.ticks.forEach((t, i) => {
      const s = radar.sectors[i]
      const hit = this.tickHits[i]!
      const inner = (s?.p99M ?? 0) * scale
      const outer = Math.min(R, (s?.maxM ?? 0) * scale)
      if (!s || s.maxM === null || outer <= inner) {
        for (const l of [t, hit]) l.setAttribute('visibility', 'hidden')
        return
      }
      const mid = (s.fromDeg + s.toDeg) / 2
      const [x1, y1] = point(mid, inner)
      const [x2, y2] = point(mid, outer)
      for (const l of [t, hit]) {
        l.setAttribute('visibility', 'visible')
        l.setAttribute('x1', String(x1))
        l.setAttribute('y1', String(y1))
        l.setAttribute('x2', String(x2))
        l.setAttribute('y2', String(y2))
      }
      t.classList.toggle('clipped', s.maxM * scale > R)
    })
    RINGS.forEach((f, i) => {
      this.ringLabels[i]!.textContent = unit.format(max * f)
    })
    this.wedges.forEach((w, i) => {
      const s = radar.sectors[i]
      if (!s || s.p99M === null) {
        w.setAttribute('d', '')
        return
      }
      const r = s.p99M * scale
      const [x1, y1] = point(s.fromDeg + 0.5, r)
      const [x2, y2] = point(s.toDeg - 0.5, r)
      w.setAttribute('d', `M${C},${C}L${x1},${y1}A${r},${r} 0 0 1 ${x2},${y2}Z`)
    })
  }

  private show(i: number): void {
    const s = this.data?.radar.sectors[i]
    if (!s || !this.data) return
    this.tip.textContent = `${s.fromDeg}° to ${s.toDeg}°: p99 ${this.data.unit.format(s.p99M)}, ${s.count.toLocaleString()} positions`
    this.tip.hidden = false
  }

  private showMax(i: number): void {
    const s = this.data?.radar.sectors[i]
    if (!s || !this.data || s.maxM === null) return
    this.tip.textContent = `${s.fromDeg}° to ${s.toDeg}°: farthest ${this.data.unit.format(s.maxM)}, ${maxTime(s, this.data.offsetMin)}`
    this.tip.hidden = false
  }
}
