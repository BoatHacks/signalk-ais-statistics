// Dependency-free SVG scatter of hourly range against a weather series,
// built once and updated in place like the charts in charts.ts: a new data
// set only moves circles from a reused pool and changes label text.
import { el, svg } from './format'
import { rightRange } from './stats'

export interface ScatterData {
  /** x: the weather value, y: the range, both already in display units. */
  points: { x: number; y: number }[]
  formatX: (v: number) => string
  formatY: (v: number) => string
  /** Below the chart, such as the correlation coefficient. */
  caption: string
}

const H = 240
const M = { top: 12, right: 24, bottom: 28, left: 72 }
const PH = H - M.top - M.bottom
const GRID = 4

function niceMax(v: number): number {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

export class ScatterChart {
  readonly element: HTMLElement
  private readonly W: number
  private readonly PW: number
  private readonly plot: SVGGElement
  private readonly yLabels: SVGTextElement[] = []
  private readonly xLabels: SVGTextElement[] = []
  private readonly dots: SVGCircleElement[] = []
  private readonly root: SVGSVGElement
  private readonly caption: HTMLElement
  private readonly xName: HTMLElement
  private readonly empty: HTMLElement

  constructor(
    private readonly color: string,
    xName: string,
    yName: string,
  ) {
    this.W = window.innerWidth < 600 ? 380 : 640
    this.PW = this.W - M.left - M.right
    this.element = el('div', { class: 'chart-wrap sk-card' })
    this.root = svg('svg', {
      viewBox: `0 0 ${this.W} ${H}`,
      class: 'chart',
      role: 'img',
    })
    this.plot = svg('g', { transform: `translate(${M.left},${M.top})` })
    this.root.append(this.plot)
    for (let i = 0; i <= GRID; i++) {
      const y = PH - (i / GRID) * PH
      const label = svg('text', {
        x: -8,
        y: y + 4,
        class: 'axis',
        'text-anchor': 'end',
      })
      this.plot.append(
        svg('line', { x1: 0, x2: this.PW, y1: y, y2: y, class: 'grid' }),
        label,
      )
      this.yLabels.push(label)
    }
    for (let i = 0; i <= GRID; i += 2) {
      const t = svg('text', {
        x: (i / GRID) * this.PW,
        y: PH + 18,
        class: 'axis',
        'text-anchor': i === 0 ? 'start' : i === GRID ? 'end' : 'middle',
      })
      this.xLabels.push(t)
      this.plot.append(t)
    }
    this.xName = el('span', {}, xName)
    this.caption = el('p', { class: 'small' })
    this.empty = el(
      'p',
      { class: 'muted empty' },
      'Too few hours with enough reports yet.',
    )
    const legend = el(
      'div',
      { class: 'legend' },
      el('span', {}, 'Across: ', this.xName),
      el('span', {}, `Up: ${yName}`),
    )
    this.element.append(this.root, legend, this.caption, this.empty)
  }

  update(d: ScatterData, xName: string): void {
    this.xName.textContent = xName
    const n = d.points.length
    this.empty.hidden = n > 0
    this.root.style.visibility = n > 0 ? 'visible' : 'hidden'
    this.caption.textContent = d.caption
    let ymax = 0
    for (const p of d.points) if (p.y > ymax) ymax = p.y
    ymax = niceMax(ymax)
    const xr = rightRange([d.points.map((p) => p.x)])
    this.yLabels.forEach((t, i) => {
      t.textContent = d.formatY((i / GRID) * ymax)
    })
    this.xLabels.forEach((t, k) => {
      t.textContent = d.formatX(xr.min + ((k * 2) / GRID) * (xr.max - xr.min))
    })
    d.points.forEach((p, i) => {
      let c = this.dots[i]
      if (!c) {
        c = svg('circle', { r: 3, class: 'dot', fill: this.color })
        this.dots.push(c)
        this.plot.append(c)
      }
      c.setAttribute(
        'cx',
        (((p.x - xr.min) / (xr.max - xr.min)) * this.PW).toFixed(1),
      )
      c.setAttribute('cy', (PH - (p.y / ymax) * PH).toFixed(1))
      c.removeAttribute('display')
    })
    for (let k = n; k < this.dots.length; k++)
      this.dots[k]!.setAttribute('display', 'none')
  }
}
