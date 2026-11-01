import { describe, expect, it } from 'vitest'
import {
  compileFormula,
  formatSI,
  makeUnit,
  quantityUnit,
} from '../../web/src/units'

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

describe('quantityUnit', () => {
  it('shows pressure in hPa, temperature in °C and ratios in percent', () => {
    expect(quantityUnit('Pa', undefined).format(101325)).toBe('1013 hPa')
    expect(quantityUnit('K', undefined).format(288.15)).toBe('15 °C')
    expect(quantityUnit('ratio', undefined).format(0.82)).toBe('82 %')
  })

  it('follows the server display unit when there is one', () => {
    const f = quantityUnit('K', {
      formula: '(value - 273.15) * 9 / 5 + 32',
      symbol: '°F',
    })
    expect(f.format(373.15)).toBe('212 °F')
  })

  it('shows unknown units as they are', () => {
    expect(quantityUnit('V', undefined).format(12.6)).toBe('12.6 V')
    expect(quantityUnit(undefined, undefined).format(3)).toBe('3')
    expect(quantityUnit('Pa', undefined).format(null)).toBe('no data')
  })
})
