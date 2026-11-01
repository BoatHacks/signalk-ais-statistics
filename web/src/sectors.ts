// Bearing sectors: one wedge per 15 degree sector, radius the sector's p99
// distance, north up, and a thin tick along each sector's centre line from
// the centre out to its farthest reception, ending in a dot. The chart's farthest reception has a
// broader tick. Built once; updates move the wedges and ticks and relabel
// the rings.
import type { SectorStats } from './api'
import { el, svg } from './format'
import { sectorLayout } from './ticks'
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

export class SectorChart {
  readonly element: HTMLElement
  private readonly root: SVGSVGElement
  private readonly ringLabels: SVGTextElement[] = []
  private readonly wedges: SVGPathElement[] = []
  private readonly ticks: SVGLineElement[] = []
  private readonly tickHits: SVGLineElement[] = []
  private readonly dots: SVGCircleElement[] = []
  private readonly dotHits: SVGCircleElement[] = []
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
      const dot = svg('circle', {
        r: 2.5,
        fill: color,
        stroke: color,
        class: 'tick-dot',
      })
      // The dot is all there is when the reception is at the wedge's edge.
      const dotHit = svg('circle', { r: 7, class: 'dot-hit' })
      for (const h of [hit, dotHit]) {
        h.addEventListener('pointerenter', () => this.showMax(s))
        h.addEventListener('pointerleave', () => (this.tip.hidden = true))
      }
      this.ticks.push(t)
      this.tickHits.push(hit)
      this.dots.push(dot)
      this.dotHits.push(dotHit)
      this.root.append(t, dot, hit, dotHit)
    }
    this.empty = el(
      'p',
      { class: 'muted empty' },
      'No positions with a known own position in this window yet.',
    )
    this.element.append(this.root, this.tip, this.empty)
  }

  update(stats: SectorStats, unit: Unit, offsetMin?: number): void {
    this.data = { stats, unit, offsetMin }
    const { max, ticks } = sectorLayout(stats, R)
    this.empty.hidden = max > 0
    this.root.style.visibility = max > 0 ? 'visible' : 'hidden'
    if (max === 0) return
    const scale = R / max
    this.ticks.forEach((t, i) => {
      const s = stats.sectors[i]
      const tick = ticks[i]
      const parts = [t, this.tickHits[i]!, this.dots[i]!, this.dotHits[i]!]
      if (!s || !tick) {
        for (const e of parts) e.setAttribute('visibility', 'hidden')
        return
      }
      for (const e of parts) e.setAttribute('visibility', 'visible')
      const mid = (s.fromDeg + s.toDeg) / 2
      const [x2, y2] = point(mid, tick.outer)
      // The tick starts at the centre; its hover area starts at the wedge's
      // edge, so the wedge keeps its own hover.
      const line = (l: SVGLineElement, r: number) => {
        const [x1, y1] = point(mid, r)
        l.setAttribute('x1', String(x1))
        l.setAttribute('y1', String(y1))
        l.setAttribute('x2', String(x2))
        l.setAttribute('y2', String(y2))
      }
      line(t, 0)
      line(this.tickHits[i]!, tick.wedge)
      for (const c of [this.dots[i]!, this.dotHits[i]!]) {
        c.setAttribute('cx', String(x2))
        c.setAttribute('cy', String(y2))
      }
      t.classList.toggle('clipped', tick.clipped)
      t.classList.toggle('farthest', tick.farthest)
      this.dots[i]!.classList.toggle('clipped', tick.clipped)
      this.dots[i]!.classList.toggle('farthest', tick.farthest)
      this.dots[i]!.setAttribute('r', tick.farthest ? '3.5' : '2.5')
    })
    RINGS.forEach((f, i) => {
      this.ringLabels[i]!.textContent = unit.format(max * f)
    })
    this.wedges.forEach((w, i) => {
      const s = stats.sectors[i]
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
    this.tip.textContent = `${s.fromDeg}° to ${s.toDeg}°: p99 ${this.data.unit.format(s.p99M)}, ${s.count.toLocaleString()} positions`
    this.tip.hidden = false
  }

  private showMax(i: number): void {
    const s = this.data?.stats.sectors[i]
    if (!s || !this.data || s.maxM === null) return
    this.tip.textContent = `${s.fromDeg}° to ${s.toDeg}°: farthest ${this.data.unit.format(s.maxM)}, ${maxTime(s, this.data.offsetMin)}`
    this.tip.hidden = false
  }
}
