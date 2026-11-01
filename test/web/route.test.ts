import { describe, expect, it } from 'vitest'
import { formatRoute, parseRoute } from '../../web/src/route'

describe('hash routes', () => {
  it('parses view and window', () => {
    expect(parseRoute('#/charts?window=7d')).toEqual({
      view: 'charts',
      window: '7d',
    })
    expect(parseRoute('#/sectors')).toEqual({ view: 'sectors', window: '24h' })
    // The view's earlier name still opens it.
    expect(parseRoute('#/radar?window=7d')).toEqual({
      view: 'sectors',
      window: '7d',
    })
  })

  it('falls back to the overview and 24 hours', () => {
    expect(parseRoute('')).toEqual({ view: 'overview', window: '24h' })
    expect(parseRoute('#/nope?window=99y')).toEqual({
      view: 'overview',
      window: '24h',
    })
  })

  it('keeps the map off the one hour window', () => {
    expect(parseRoute('#/map?window=1h')).toEqual({
      view: 'map',
      window: '24h',
    })
  })

  it('formats back', () => {
    expect(formatRoute({ view: 'charts', window: '7d' })).toBe(
      '#/charts?window=7d',
    )
  })
})
