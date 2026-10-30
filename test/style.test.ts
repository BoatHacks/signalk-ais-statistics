import { describe, expect, it } from 'vitest'
import { CELL_HIGH, CELL_LOW, cellColour } from '../src/style'

describe('cellColour', () => {
  it('runs from the low to the high colour', () => {
    expect(cellColour(0)).toBe(CELL_LOW)
    expect(cellColour(1)).toBe(CELL_HIGH)
  })

  it('interpolates in RGB and clamps out of range values', () => {
    expect(cellColour(0.5)).toBe('#b9358c')
    expect(cellColour(-1)).toBe(CELL_LOW)
    expect(cellColour(2)).toBe(CELL_HIGH)
    expect(cellColour(Number.NaN)).toBe(CELL_LOW)
  })
})
