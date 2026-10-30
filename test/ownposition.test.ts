import { describe, expect, it } from 'vitest'
import { OwnPosition } from '../src/ownposition'

describe('OwnPosition', () => {
  it('returns the position while fresh and undefined when stale', () => {
    const own = new OwnPosition(60_000)
    expect(own.at(0)).toBeUndefined()
    own.update({ latitude: 1, longitude: 2 }, 1000)
    expect(own.at(30_000)).toEqual({ lat: 1, lon: 2 })
    expect(own.at(61_001)).toBeUndefined()
    expect(own.ageMs(31_000)).toBe(30_000)
  })

  it('ignores invalid positions', () => {
    const own = new OwnPosition(60_000)
    own.update({ latitude: 1, longitude: 2 }, 0)
    own.update({ latitude: 'x', longitude: 2 }, 10)
    own.update({ latitude: 91, longitude: 2 }, 10)
    own.update(null, 10)
    expect(own.ageMs(10)).toBe(10)
  })
})
