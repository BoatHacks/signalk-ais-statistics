// Unit handling (SPEC 7): the plugin serves SI values, and the app shows
// them in the user's preferred units from the path metadata's
// `displayUnits`, or in SI with ISO prefixes when there is none.

export type SIUnit = 'm' | 'm2'

export interface DisplayUnits {
  formula?: string
  symbol?: string
}

export interface Unit {
  symbol: string
  toDisplay(si: number): number
  format(si: number | null | undefined): string
  /** Formats a value already converted with `toDisplay`. */
  formatDisplay(v: number): string
}

type Fn = (value: number) => number

/**
 * Compiles a display unit formula such as `value * 0.000539957`. Only
 * numbers, `value`, `+ - * / ^` and parentheses are accepted, so a formula
 * from the server is never run as code. Returns undefined when it does not
 * parse.
 */
export function compileFormula(src: string): Fn | undefined {
  const tokens = src.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|value|[-+*/^()]|\S/gi)
  if (!tokens) return undefined
  let i = 0
  const peek = () => tokens[i]
  const fail = (): never => {
    throw new Error('bad formula')
  }
  const expr = (): Fn => {
    let left = term()
    while (peek() === '+' || peek() === '-') {
      const op = tokens[i++]
      const l = left
      const r = term()
      left = op === '+' ? (v) => l(v) + r(v) : (v) => l(v) - r(v)
    }
    return left
  }
  const term = (): Fn => {
    let left = power()
    while (peek() === '*' || peek() === '/') {
      const op = tokens[i++]
      const l = left
      const r = power()
      left = op === '*' ? (v) => l(v) * r(v) : (v) => l(v) / r(v)
    }
    return left
  }
  const power = (): Fn => {
    const base = unary()
    if (peek() !== '^') return base
    i++
    const exp = power()
    return (v) => base(v) ** exp(v)
  }
  const unary = (): Fn => {
    if (peek() === '-') {
      i++
      const f = unary()
      return (v) => -f(v)
    }
    if (peek() === '+') {
      i++
      return unary()
    }
    return atom()
  }
  const atom = (): Fn => {
    const t = tokens[i++]
    if (t === undefined) return fail()
    if (t === '(') {
      const f = expr()
      if (tokens[i++] !== ')') fail()
      return f
    }
    if (t.toLowerCase() === 'value') return (v) => v
    const n = Number(t)
    if (!Number.isFinite(n)) return fail()
    return () => n
  }
  try {
    const f = expr()
    return i === tokens.length ? f : undefined
  } catch {
    return undefined
  }
}

/** Three significant figures at most, without trailing zeros or grouping. */
export function short(n: number): string {
  const a = Math.abs(n)
  if (a >= 100 || a === 0) return String(Math.round(n))
  return String(Number(n.toFixed(a >= 10 ? 1 : a >= 1 ? 1 : 2)))
}

export function formatSI(v: number | null | undefined, unit: SIUnit): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'no data'
  if (unit === 'm')
    return Math.abs(v) >= 1000 ? `${short(v / 1000)} km` : `${short(v)} m`
  return Math.abs(v) >= 1e6 ? `${short(v / 1e6)} km²` : `${short(v)} m²`
}

export function makeUnit(si: SIUnit, meta: DisplayUnits | undefined): Unit {
  // A display unit that is the SI unit itself adds nothing over SI with
  // ISO prefixes, which reads better for large values.
  const identity = meta?.formula?.replace(/\s/g, '').toLowerCase() === 'value'
  const f =
    meta?.formula && !identity ? compileFormula(meta.formula) : undefined
  if (f && meta?.symbol) {
    const symbol = meta.symbol
    return {
      symbol,
      toDisplay: f,
      format: (v) =>
        v === null || v === undefined || !Number.isFinite(v)
          ? 'no data'
          : `${short(f(v))} ${symbol}`,
      formatDisplay: (v) => `${short(v)} ${symbol}`,
    }
  }
  return {
    symbol: si === 'm' ? 'm' : 'm²',
    toDisplay: (v) => v,
    format: (v) => formatSI(v, si),
    formatDisplay: (v) => formatSI(v, si),
  }
}
