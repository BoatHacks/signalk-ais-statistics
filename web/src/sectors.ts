// Bearing sectors: one wedge per 15 degree sector, radius the sector's p99
// distance, north up. The sector holding the chart's farthest reception has
// a bolder outline and a dot on its centre line at that distance. Built
// once; updates move the wedges and the dot and relabel the rings.
import type { SectorStats } from './api'
import { el, svg } from './format'
import { sectorLayout } from './sector-layout'
import { maxTime } from './time'
import type { Unit } from './units'

const SIZE = 320
const C = SIZE / 2
const R = C - 28
const RINGS = [0.25, 0.5, 0.75, 1]

function point(bearing: number, r: number): [number, number] {
  const a = ((bearing - 90) * Math.PI) / 180
  return [C + r * Math.cos(a), C + r * Math.sin(a)]
}

export { sectorScale } from './sector-layout'

export class SectorChart {
  readonly element: HTMLElement
  private readonly root: SVGSVGElement
  private readonly ringLabels: SVGTextElement[] = []
  private readonly wedges: SVGPathElement[] = []
  private readonly dot: SVGCircleElement
  private readonly dotHit: SVGCircleElement
  private farthest: number | undefined
  private readonly tip: HTMLElement
  private readonly empty: HTMLElement
  private data:
    | { stats: SectorStats; unit: Unit; offsetMin: number | undefined }
    | undefined

  constructor(color: string) {
    this.element = el('div', { class: 'sectors-wrap' })
    this.root = svg('svg', {
      viewBox: `0 0 ${SIZE} ${SIZE}`,
      class: 'sectors',
      role: 'img',
    })
    this.root.style.setProperty('--sector', color)
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
    this.dot = svg('circle', {
      r: 3,
      fill: color,
      stroke: color,
      class: 'farthest-dot',
    })
    // A wider invisible circle over the small dot makes it easy to hover.
    this.dotHit = svg('circle', { r: 8, class: 'dot-hit' })
    this.dotHit.addEventListener('pointerenter', () => {
      if (this.farthest !== undefined) this.showMax(this.farthest)
    })
    this.dotHit.addEventListener('pointerleave', () => (this.tip.hidden = true))
    this.root.append(this.dot, this.dotHit)
    this.empty = el(
      'p',
      { class: 'muted empty' },
      'No positions with a known own position in this window yet.',
    )
    this.element.append(this.root, this.tip, this.empty)
  }

  update(
    stats: SectorStats,
    unit: Unit,
    offsetMin?: number,
    /** The outer ring in metres, so charts side by side share a scale. */
    scaleM?: number,
  ): void {
    this.data = { stats, unit, offsetMin }
    const { max, farthest } = sectorLayout(stats, R, scaleM)
    this.empty.hidden = max > 0
    this.root.style.visibility = max > 0 ? 'visible' : 'hidden'
    if (max === 0) return
    const scale = R / max
    this.farthest = farthest?.sector
    const s = farthest ? stats.sectors[farthest.sector] : undefined
    for (const c of [this.dot, this.dotHit])
      c.setAttribute('visibility', farthest && s ? 'visible' : 'hidden')
    if (farthest && s) {
      const [x, y] = point((s.fromDeg + s.toDeg) / 2, farthest.r)
      for (const c of [this.dot, this.dotHit]) {
        c.setAttribute('cx', String(x))
        c.setAttribute('cy', String(y))
      }
      this.dot.classList.toggle('clipped', farthest.clipped)
    }
    RINGS.forEach((f, i) => {
      this.ringLabels[i]!.textContent = unit.format(max * f)
    })
    this.wedges.forEach((w, i) => {
      const s = stats.sectors[i]
      w.classList.toggle('farthest', i === this.farthest)
      // Drawn last among the wedges, so its neighbours do not cover the
      // bolder outline.
      if (i === this.farthest) this.root.insertBefore(w, this.dot)
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
    const s = this.data?.stats.sectors[i]
    if (!s || !this.data) return
    const far =
      s.maxM === null
        ? ''
        : `, farthest ${this.data.unit.format(s.maxM)} (${maxTime(s, this.data.offsetMin)})`
    this.tip.textContent = `${s.fromDeg}° to ${s.toDeg}°: p99 ${this.data.unit.format(s.p99M)}${far}, ${s.count.toLocaleString()} positions`
    this.tip.hidden = false
  }

  private showMax(i: number): void {
    const s = this.data?.stats.sectors[i]
    if (!s || !this.data || s.maxM === null) return
    this.tip.textContent = `${s.fromDeg}° to ${s.toDeg}°: farthest ${this.data.unit.format(s.maxM)}, ${maxTime(s, this.data.offsetMin)}`
    this.tip.hidden = false
  }
}
