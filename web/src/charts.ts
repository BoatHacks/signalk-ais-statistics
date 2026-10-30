// Dependency-free SVG charts (line and stacked bars) built once and then
// updated in place: a new data set only changes path `d` attributes, rect
// geometry and label text, never the chart's DOM structure.
import { el, svg } from './format'
import { formatDate, formatDateTime, formatTime } from './time'

export interface SeriesDef {
  name: string
  /** A CSS colour, normally one of the semantic theme variables. */
  color: string
}

export interface ChartData {
  times: number[]
  /** One column per series, same length as `times`. */
  columns: (number | null)[][]
  format: (v: number) => string
  offsetMin: number | undefined
}

const H = 240
const M = { top: 12, right: 24, bottom: 28, left: 72 }
const PH = H - M.top - M.bottom
const GRID = 4
const MAX_TICKS = 6

function niceMax(v: number): number {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

export class Chart {
  readonly element: HTMLElement
  private readonly W: number
  private readonly PW: number
  private readonly plot: SVGGElement
  private readonly gridLabels: SVGTextElement[] = []
  private readonly ticks: SVGTextElement[] = []
  private readonly lines: SVGPathElement[] = []
  private readonly bars: SVGRectElement[] = []
  private readonly cross: SVGLineElement
  private readonly tip: HTMLElement
  private readonly empty: HTMLElement
  private readonly root: SVGSVGElement
  private data: ChartData | undefined

  constructor(
    private readonly kind: 'line' | 'bars',
    private readonly series: SeriesDef[],
  ) {
    // The drawing width follows the screen so text stays legible on a phone.
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
      this.gridLabels.push(label)
    }
    for (let i = 0; i < MAX_TICKS; i++) {
      const t = svg('text', { y: PH + 18, class: 'axis' })
      this.ticks.push(t)
      this.plot.append(t)
    }
    if (kind === 'line')
      for (const s of series) {
        const p = svg('path', { class: 'line', stroke: s.color })
        this.lines.push(p)
        this.plot.append(p)
      }
    this.cross = svg('line', {
      y1: 0,
      y2: PH,
      class: 'cross',
      visibility: 'hidden',
    })
    this.plot.append(this.cross)
    this.tip = el('div', { class: 'tip', hidden: '' })
    this.empty = el(
      'p',
      { class: 'muted empty' },
      'No data in this window yet.',
    )
    const legend = el(
      'div',
      { class: 'legend' },
      ...series.map((s) =>
        el('span', {}, el('i', { style: `background:${s.color}` }), s.name),
      ),
    )
    this.element.append(this.root, legend, this.tip, this.empty)
    this.root.addEventListener('pointermove', (e) => this.hover(e))
    this.root.addEventListener('pointerleave', () => {
      this.tip.hidden = true
      this.cross.setAttribute('visibility', 'hidden')
    })
  }

  private xOf(i: number, n: number): number {
    if (this.kind === 'bars') return (i + 0.5) * (this.PW / n)
    return n <= 1 ? this.PW / 2 : (i / (n - 1)) * this.PW
  }

  update(d: ChartData): void {
    this.data = d
    const n = d.times.length
    this.empty.hidden = n > 0
    this.root.style.visibility = n > 0 ? 'visible' : 'hidden'
    let max = 0
    if (this.kind === 'bars') {
      for (let i = 0; i < n; i++) {
        let t = 0
        for (const c of d.columns) t += c[i] ?? 0
        max = Math.max(max, t)
      }
    } else {
      for (const c of d.columns)
        for (const v of c) if (v !== null && v > max) max = v
    }
    max = niceMax(max)
    this.gridLabels.forEach((t, i) => {
      t.textContent = d.format((i / GRID) * max)
    })
    this.updateTicks(d)
    const y = (v: number) => PH - (v / max) * PH
    if (this.kind === 'line') {
      this.lines.forEach((path, s) => {
        let p = ''
        let pen = false
        ;(d.columns[s] ?? []).forEach((v, i) => {
          if (v === null) {
            pen = false
            return
          }
          p += `${pen ? 'L' : 'M'}${this.xOf(i, n).toFixed(1)},${y(v).toFixed(1)}`
          pen = true
        })
        path.setAttribute('d', p)
      })
      return
    }
    // Stacked bars from a pool of rects, reused across updates.
    const band = this.PW / Math.max(1, n)
    const bw = Math.max(1, band - 2)
    let used = 0
    for (let i = 0; i < n; i++) {
      let base = PH
      d.columns.forEach((col, s) => {
        const v = col[i] ?? 0
        if (v <= 0) return
        const h = (v / max) * PH
        let r = this.bars[used]
        if (!r) {
          r = svg('rect', {})
          this.bars.push(r)
          this.plot.insertBefore(r, this.cross)
        }
        used++
        r.setAttribute('x', String(this.xOf(i, n) - bw / 2))
        r.setAttribute('y', String(base - h))
        r.setAttribute('width', String(bw))
        // A 2 px gap between stacked segments.
        r.setAttribute('height', String(Math.max(0, h - (base < PH ? 2 : 0))))
        r.setAttribute('fill', this.series[s]!.color)
        r.removeAttribute('display')
        base -= h
      })
    }
    for (let k = used; k < this.bars.length; k++)
      this.bars[k]!.setAttribute('display', 'none')
  }

  private updateTicks(d: ChartData): void {
    const n = d.times.length
    const span = n > 1 ? d.times[n - 1]! - d.times[0]! : 0
    const count = Math.min(this.W < 600 ? 4 : MAX_TICKS, n)
    this.ticks.forEach((t, i) => {
      if (i >= count) {
        t.textContent = ''
        return
      }
      const idx = Math.round((i / Math.max(1, count - 1)) * (n - 1))
      t.setAttribute('x', String(this.xOf(idx, n)))
      t.setAttribute(
        'text-anchor',
        count > 1 && i === 0
          ? 'start'
          : count > 1 && i === count - 1
            ? 'end'
            : 'middle',
      )
      const ms = d.times[idx]!
      t.textContent =
        span <= 2 * 86_400_000
          ? formatTime(ms, d.offsetMin)
          : formatDate(ms, d.offsetMin).slice(5)
    })
  }

  private hover(e: PointerEvent): void {
    const d = this.data
    if (!d || d.times.length === 0) return
    const n = d.times.length
    const r = this.root.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * this.W - M.left
    let best = 0
    for (let i = 1; i < n; i++)
      if (Math.abs(this.xOf(i, n) - x) < Math.abs(this.xOf(best, n) - x))
        best = i
    const cx = String(this.xOf(best, n))
    this.cross.setAttribute('x1', cx)
    this.cross.setAttribute('x2', cx)
    this.cross.setAttribute('visibility', 'visible')
    this.tip.replaceChildren(
      el('b', {}, formatDateTime(d.times[best]!, d.offsetMin)),
      ...this.series.map((s, k) => {
        const v = d.columns[k]?.[best] ?? null
        return el(
          'div',
          {},
          el('i', { style: `background:${s.color}` }),
          `${s.name}: ${v === null ? 'no data' : d.format(v)}`,
        )
      }),
    )
    this.tip.hidden = false
    const left = ((this.xOf(best, n) + M.left) / this.W) * r.width
    this.tip.style.left = `${Math.min(left, r.width - 170)}px`
  }
}
