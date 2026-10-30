import { describe, expect, it } from 'vitest'
import {
  classOf,
  isPositionReport,
  isVesselMessage,
  typeGroup,
} from '../src/classify'

describe('classOf', () => {
  it('derives the class from the message type', () => {
    for (const t of [1, 2, 3, 5]) expect(classOf(t)).toBe('A')
    for (const t of [18, 19, 24]) expect(classOf(t)).toBe('B')
    for (const t of [4, 9, 21, 27]) expect(classOf(t)).toBe('other')
  })
})

describe('isPositionReport', () => {
  it('matches types 1, 2, 3, 18, 19 and 9', () => {
    const yes = [1, 2, 3, 9, 18, 19]
    for (let t = 1; t <= 27; t++)
      expect(isPositionReport(t)).toBe(yes.includes(t))
  })
})

describe('isVesselMessage', () => {
  it('counts class A and B messages as vessels, not base stations', () => {
    expect(isVesselMessage(1)).toBe(true)
    expect(isVesselMessage(24)).toBe(true)
    expect(isVesselMessage(4)).toBe(false)
    expect(isVesselMessage(21)).toBe(false)
  })
})

describe('typeGroup', () => {
  it.each([
    [undefined, 'unknown'],
    [30, 'fishing'],
    [36, 'pleasureCraft'],
    [37, 'pleasureCraft'],
    [60, 'passenger'],
    [69, 'passenger'],
    [70, 'cargo'],
    [79, 'cargo'],
    [80, 'tanker'],
    [89, 'tanker'],
    [0, 'other'],
    [52, 'other'],
    [90, 'other'],
  ])('maps %s to %s', (code, group) => {
    expect(typeGroup(code)).toBe(group)
  })
})
