export function nm(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'no data'
  return `${v < 10 && v !== 0 ? v.toFixed(1) : Math.round(v)} nm`
}

export function int(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'no data'
  return Math.round(v).toLocaleString()
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  for (const c of children) e.append(c)
  return e
}

const SVG_NS = 'http://www.w3.org/2000/svg'

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  for (const c of children) e.append(c)
  return e
}
