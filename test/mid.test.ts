import { describe, expect, it } from 'vitest'
import { COUNTRY_NAMES, flagOf, midOf } from '../src/mid'

// Synthetic MMSIs: valid MIDs with made-up station numbers.
describe('midOf', () => {
  it.each([
    ['261000001', '261'],
    ['224000001', '224'],
    ['982610001', '261'],
  ])('reads the MID of %s', (mmsi, mid) => {
    expect(midOf(mmsi)).toBe(mid)
  })

  it.each(['002610001', '992610001', '111261001', '970000001', '26100001'])(
    'has no MID for %s',
    (mmsi) => {
      expect(midOf(mmsi)).toBeUndefined()
    },
  )
})

describe('flagOf', () => {
  it('maps several MIDs of one country to its code', () => {
    expect(flagOf('224000001')).toBe('ES')
    expect(flagOf('225000001')).toBe('ES')
    expect(COUNTRY_NAMES.ES).toBe('Spain')
  })

  it('returns unknown for MMSIs without a listed MID', () => {
    expect(flagOf('999000001')).toBe('unknown')
    expect(flagOf('002610001')).toBe('unknown')
  })
})
