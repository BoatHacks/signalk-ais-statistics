// Bearing radar: one wedge per 15 degree sector, radius the sector's p99
// distance, north up.
import type { Radar } from './api'
import { el, nm, svg } from './format'

const SIZE = 320
const C = SIZE / 2
const R = C - 28

function point(bearing: number, r: number): [number, number] {
  const a = ((bearing - 90) * Math.PI) / 180
  return [C + r * Math.cos(a), C + r * Math.sin(a)]
}

export function radarChart(radar: Radar, color: string): HTMLElement {
  const max = Math.max(0, ...radar.sectors.map((s) => s.p99Nm ?? 0))
  const wrap = el('div', { class: 'radar-wrap' })
  if (max === 0) {
    wrap.append(
      el(
        'p',
        { class: 'muted' },
        'No positions with a known own position in this window yet.',
      ),
    )
    return wrap
  }
  const scale = R / max
  const root = svg('svg', {
    viewBox: `0 0 ${SIZE} ${SIZE}`,
    class: 'radar',
    role: 'img',
  })
  for (const f of [0.25, 0.5, 0.75, 1]) {
    root.append(svg('circle', { cx: C, cy: C, r: R * f, class: 'grid' }))
    // Ring labels sit between the north-east sectors to stay readable.
    const [lx, ly] = point(45, R * f)
    root.append(
      svg('text', { x: lx + 2, y: ly - 2, class: 'axis' }, nm(max * f)),
    )
  }
  for (const [label, b] of [
    ['N', 0],
    ['E', 90],
    ['S', 180],
    ['W', 270],
  ] as const) {
    const [x, y] = point(b, R + 14)
    root.append(
      svg(
        'text',
        { x, y: y + 4, class: 'axis', 'text-anchor': 'middle' },
        label,
      ),
    )
  }
  const tip = el('div', { class: 'tip', hidden: '' })
  for (const s of radar.sectors) {
    if (s.p99Nm === null) continue
    const r = s.p99Nm * scale
    const [x1, y1] = point(s.fromDeg + 0.5, r)
    const [x2, y2] = point(s.toDeg - 0.5, r)
    const wedge = svg('path', {
      d: `M${C},${C}L${x1},${y1}A${r},${r} 0 0 1 ${x2},${y2}Z`,
      fill: color,
      class: 'wedge',
    })
    wedge.addEventListener('pointerenter', () => {
      tip.textContent = `${s.fromDeg}° to ${s.toDeg}°: p99 ${nm(s.p99Nm)}, ${s.count.toLocaleString()} positions`
      tip.hidden = false
    })
    wedge.addEventListener('pointerleave', () => (tip.hidden = true))
    root.append(wedge)
  }
  wrap.append(root, tip)
  return wrap
}
