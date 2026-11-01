import { describe, expect, it } from 'vitest'
import { defaultCompare, formatRoute, parseRoute } from '../../web/src/route'

describe('hash routes', () => {
  it('parses view and window', () => {
    expect(parseRoute('#/charts?window=7d')).toEqual({
      view: 'charts',
      window: '7d',
    })
    expect(parseRoute('#/sectors')).toEqual({ view: 'sectors', window: '24h' })
    // No alias for the view's earlier name: it falls back like any other.
    expect(parseRoute('#/radar')).toEqual({ view: 'overview', window: '24h' })
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

  it('parses the compare view with a date and days, within bounds', () => {
    const now = Date.UTC(2030, 0, 20, 12)
    expect(parseRoute('#/compare?date=2030-01-08&days=3', now)).toEqual({
      view: 'compare',
      window: '24h',
      compare: { date: '2030-01-08', days: 3, source: 'all' },
    })
    expect(
      parseRoute('#/compare?date=2030-01-08&days=3&source=nmea0183', now)
        .compare?.source,
    ).toBe('nmea0183')
    expect(
      parseRoute('#/compare?date=2030-01-08&days=3&source=a.b', now).compare
        ?.source,
    ).toBe('all')
    // The default: seven days each side, the after window ending today.
    expect(defaultCompare(now)).toEqual({
      date: '2030-01-14',
      days: 7,
      source: 'all',
    })
    for (const hash of [
      '#/compare',
      '#/compare?date=2030-02-30&days=0',
      '#/compare?date=2031-01-01&days=8',
      '#/compare?date=yesterday&days=x',
    ])
      expect(parseRoute(hash, now).compare, hash).toEqual(defaultCompare(now))
  })

  it('formats the compare view with its own parameters', () => {
    expect(
      formatRoute({
        view: 'compare',
        window: '7d',
        compare: { date: '2030-01-08', days: 7, source: 'all' },
      }),
    ).toBe('#/compare?date=2030-01-08&days=7')
    expect(
      formatRoute({
        view: 'compare',
        window: '7d',
        compare: { date: '2030-01-08', days: 7, source: 'N2KAnalyzerOut' },
      }),
    ).toBe('#/compare?date=2030-01-08&days=7&source=N2KAnalyzerOut')
  })
})
