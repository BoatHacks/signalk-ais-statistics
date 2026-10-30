import { describe, expect, it } from 'vitest'
import { compileFormula, formatSI, makeUnit } from '../../web/src/units'

describe('compileFormula', () => {
  it('evaluates arithmetic on value with precedence and parentheses', () => {
    expect(compileFormula('value * 0.000539957')!(1852)).toBeCloseTo(1, 5)
    expect(
      compileFormula('(value - 273.15) * 9 / 5 + 32')!(373.15),
    ).toBeCloseTo(212, 9)
    expect(compileFormula('-value + 2 ^ 3')!(1)).toBe(7)
    expect(compileFormula('value/1000')!(2500)).toBe(2.5)
  })

  it('rejects anything that is not plain arithmetic', () => {
    expect(compileFormula('alert(1)')).toBeUndefined()
    expect(compileFormula('value * ')).toBeUndefined()
    expect(compileFormula('value; 1')).toBeUndefined()
    expect(compileFormula('')).toBeUndefined()
  })
})

describe('formatSI', () => {
  it('scales metres with ISO prefixes', () => {
    expect(formatSI(12300, 'm')).toBe('12.3 km')
    expect(formatSI(850, 'm')).toBe('850 m')
    expect(formatSI(0, 'm')).toBe('0 m')
    expect(formatSI(185200, 'm')).toBe('185 km')
  })

  it('scales areas by the square of the prefix', () => {
    expect(formatSI(4.1e6, 'm2')).toBe('4.1 km²')
    expect(formatSI(5000, 'm2')).toBe('5000 m²')
    expect(formatSI(2.34e9, 'm2')).toBe('2340 km²')
  })

  it('shows no data for null', () => {
    expect(formatSI(null, 'm')).toBe('no data')
  })
})

describe('makeUnit', () => {
  it('converts with the display units from metadata', () => {
    const u = makeUnit('m', {
      formula: 'value * 0.000539957',
      symbol: 'nmi',
    })
    expect(u.format(1852 * 12.34)).toBe('12.3 nmi')
    expect(u.format(1852 * 123.4)).toBe('123 nmi')
    expect(u.toDisplay(1852)).toBeCloseTo(1, 5)
    expect(u.symbol).toBe('nmi')
  })

  it('keeps ISO prefixes when the display unit is the SI unit itself', () => {
    const u = makeUnit('m2', { formula: 'value', symbol: 'm2' })
    expect(u.format(4.1e9)).toBe('4100 km²')
  })

  it('falls back to SI with prefixes without usable metadata', () => {
    const u = makeUnit('m', { formula: 'oops(', symbol: 'nmi' })
    expect(u.format(12300)).toBe('12.3 km')
    expect(makeUnit('m2', undefined).format(4.1e6)).toBe('4.1 km²')
  })
})
