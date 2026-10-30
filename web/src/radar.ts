// Bearing radar: one wedge per 15 degree sector, radius the sector's p99
// distance, north up. Built once; updates move the wedges and relabel the
// rings.
import type { Radar } from './api'
import { el, svg } from './format'
import type { Unit } from './units'

const SIZE = 320
const C = SIZE / 2
const R = C - 28
const RINGS = [0.25, 0.5, 0.75, 1]

function point(bearing: number, r: number): [number, number] {
  const a = ((bearing - 90) * Math.PI) / 180
  return [C + r * Math.cos(a), C + r * Math.sin(a)]
}

export class RadarChart {
  readonly element: HTMLElement
  private readonly root: SVGSVGElement
  private readonly ringLabels: SVGTextElement[] = []
  private readonly wedges: SVGPathElement[] = []
  private readonly tip: HTMLElement
  private readonly empty: HTMLElement
  private data: { radar: Radar; unit: Unit } | undefined

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
    this.empty = el(
      'p',
      { class: 'muted empty' },
      'No positions with a known own position in this window yet.',
    )
    this.element.append(this.root, this.tip, this.empty)
  }

  update(radar: Radar, unit: Unit): void {
    this.data = { radar, unit }
    const max = Math.max(0, ...radar.sectors.map((s) => s.p99M ?? 0))
    this.empty.hidden = max > 0
    this.root.style.visibility = max > 0 ? 'visible' : 'hidden'
    if (max === 0) return
    const scale = R / max
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
}
