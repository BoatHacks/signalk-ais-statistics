// Small dependency-free SVG charts: a line chart and a stacked bar chart,
// both with a hover tooltip, a legend and recessive axes.
import { el, svg } from './format'

export interface SeriesDef {
  name: string
  color: string
  values: (number | null)[]
}

// The drawing width follows the screen so text stays legible on a phone.
let W = 640
const H = 240
const M = { top: 12, right: 24, bottom: 28, left: 64 }
let PW = W - M.left - M.right
const PH = H - M.top - M.bottom

function size(): void {
  W = window.innerWidth < 600 ? 380 : 640
  PW = W - M.left - M.right
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

function timeLabel(iso: string, spanMs: number): string {
  const d = new Date(iso)
  if (spanMs <= 2 * 86_400_000)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function frame(
  times: string[],
  max: number,
  format: (v: number) => string,
): { root: SVGSVGElement; plot: SVGGElement } {
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'chart',
    role: 'img',
  })
  const plot = svg('g', { transform: `translate(${M.left},${M.top})` })
  root.append(plot)
  for (let i = 0; i <= 4; i++) {
    const y = PH - (i / 4) * PH
    plot.append(
      svg('line', { x1: 0, x2: PW, y1: y, y2: y, class: 'grid' }),
      svg(
        'text',
        { x: -6, y: y + 4, class: 'axis', 'text-anchor': 'end' },
        format((i / 4) * max),
      ),
    )
  }
  const span =
    times.length > 1
      ? Date.parse(times[times.length - 1]!) - Date.parse(times[0]!)
      : 0
  const ticks = Math.min(W < 600 ? 4 : 6, times.length)
  for (let i = 0; i < ticks; i++) {
    const idx = Math.round((i / Math.max(1, ticks - 1)) * (times.length - 1))
    const x = xAt(idx, times.length)
    const anchor =
      ticks > 1 && i === 0
        ? 'start'
        : ticks > 1 && i === ticks - 1
          ? 'end'
          : 'middle'
    plot.append(
      svg(
        'text',
        { x, y: PH + 18, class: 'axis', 'text-anchor': anchor },
        timeLabel(times[idx]!, span),
      ),
    )
  }
  return { root, plot }
}

function xAt(i: number, n: number): number {
  return n <= 1 ? PW / 2 : (i / (n - 1)) * PW
}

function legend(series: SeriesDef[]): HTMLElement {
  return el(
    'div',
    { class: 'legend' },
    ...series.map((s) =>
      el('span', {}, el('i', { style: `background:${s.color}` }), s.name),
    ),
  )
}

function hover(
  root: SVGSVGElement,
  wrap: HTMLElement,
  times: string[],
  series: SeriesDef[],
  format: (v: number | null) => string,
  xOf: (i: number) => number,
): void {
  const tip = el('div', { class: 'tip', hidden: '' })
  const cross = svg('line', {
    y1: 0,
    y2: PH,
    class: 'cross',
    visibility: 'hidden',
  })
  root.querySelector('g')!.append(cross)
  wrap.append(tip)
  const n = times.length
  root.addEventListener('pointermove', (e) => {
    const r = root.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W - M.left
    let best = 0
    for (let i = 1; i < n; i++)
      if (Math.abs(xOf(i) - x) < Math.abs(xOf(best) - x)) best = i
    cross.setAttribute('x1', String(xOf(best)))
    cross.setAttribute('x2', String(xOf(best)))
    cross.setAttribute('visibility', 'visible')
    tip.replaceChildren(
      el('b', {}, new Date(times[best]!).toLocaleString()),
      ...series.map((s) =>
        el(
          'div',
          {},
          el('i', { style: `background:${s.color}` }),
          `${s.name}: ${format(s.values[best] ?? null)}`,
        ),
      ),
    )
    tip.hidden = false
    const left = ((xOf(best) + M.left) / W) * r.width
    tip.style.left = `${Math.min(left, r.width - 160)}px`
  })
  root.addEventListener('pointerleave', () => {
    tip.hidden = true
    cross.setAttribute('visibility', 'hidden')
  })
}

export function lineChart(
  times: string[],
  series: SeriesDef[],
  format: (v: number | null) => string,
): HTMLElement {
  size()
  const wrap = el('div', { class: 'chart-wrap' })
  if (times.length === 0) {
    wrap.append(el('p', { class: 'muted' }, 'No data in this window yet.'))
    return wrap
  }
  let max = 0
  for (const s of series)
    for (const v of s.values) if (v !== null && v > max) max = v
  max = niceMax(max)
  const { root, plot } = frame(times, max, (v) => format(v))
  const y = (v: number) => PH - (v / max) * PH
  for (const s of series) {
    let d = ''
    let pen = false
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'}${xAt(i, times.length).toFixed(1)},${y(v).toFixed(1)}`
      pen = true
    })
    plot.append(svg('path', { d, class: 'line', stroke: s.color }))
  }
  wrap.append(root, legend(series))
  hover(root, wrap, times, series, format, (i) => xAt(i, times.length))
  return wrap
}

export function stackedBars(
  times: string[],
  series: SeriesDef[],
  format: (v: number | null) => string,
): HTMLElement {
  size()
  const wrap = el('div', { class: 'chart-wrap' })
  if (times.length === 0) {
    wrap.append(el('p', { class: 'muted' }, 'No data in this window yet.'))
    return wrap
  }
  const n = times.length
  const totals = times.map((_, i) =>
    series.reduce((a, s) => a + (s.values[i] ?? 0), 0),
  )
  const max = niceMax(Math.max(0, ...totals))
  const { root, plot } = frame(times, max, (v) => format(v))
  const band = PW / n
  const bw = Math.max(1, band - 2)
  const xOf = (i: number) => i * band + band / 2
  for (let i = 0; i < n; i++) {
    let base = PH
    for (const s of series) {
      const v = s.values[i] ?? 0
      if (v <= 0) continue
      const h = (v / max) * PH
      plot.append(
        svg('rect', {
          x: xOf(i) - bw / 2,
          y: base - h,
          width: bw,
          height: Math.max(0, h - (base < PH ? 2 : 0)),
          fill: s.color,
          rx: Math.min(2, bw / 4),
        }),
      )
      base -= h
    }
  }
  wrap.append(root, legend(series))
  hover(root, wrap, times, series, format, xOf)
  return wrap
}
