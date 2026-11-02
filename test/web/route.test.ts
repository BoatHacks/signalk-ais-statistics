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

  it('keeps the own vessel mode of the map, and only there', () => {
    expect(parseRoute('#/map?window=7d&mode=underway')).toEqual({
      view: 'map',
      window: '7d',
      mode: 'underway',
    })
    expect(parseRoute('#/map?mode=stationary').mode).toBe('stationary')
    for (const m of ['all', 'unknown', 'x', ''])
      expect(parseRoute(`#/map?mode=${m}`), m).toEqual({
        view: 'map',
        window: '24h',
      })
    expect(parseRoute('#/charts?mode=underway')).toEqual({
      view: 'charts',
      window: '24h',
    })
    expect(formatRoute({ view: 'map', window: '7d', mode: 'stationary' })).toBe(
      '#/map?window=7d&mode=stationary',
    )
    expect(formatRoute({ view: 'map', window: '7d', mode: 'all' })).toBe(
      '#/map?window=7d',
    )
    expect(
      formatRoute({ view: 'charts', window: '7d', mode: 'underway' }),
    ).toBe('#/charts?window=7d')
  })

  it('formats back', () => {
    expect(formatRoute({ view: 'charts', window: '7d' })).toBe(
      '#/charts?window=7d',
    )
  })

  it('parses the compare view with an hour and a length, within bounds', () => {
    const now = Date.UTC(2030, 0, 20, 12, 30)
    expect(parseRoute('#/compare?at=2030-01-08T14:00Z&hours=6', now)).toEqual({
      view: 'compare',
      window: '24h',
      compare: { at: Date.UTC(2030, 0, 8, 14), hours: 6, source: 'all' },
    })
    expect(
      parseRoute('#/compare?at=2030-01-08T14:00Z&hours=6&source=nmea0183', now)
        .compare?.source,
    ).toBe('nmea0183')
    expect(
      parseRoute('#/compare?at=2030-01-08T14:00Z&hours=6&source=a.b', now)
        .compare?.source,
    ).toBe('all')
    // The current hour is the latest change there is.
    expect(
      parseRoute('#/compare?at=2030-01-20T12:00Z&hours=1', now).compare?.at,
    ).toBe(Date.UTC(2030, 0, 20, 12))
    // The default: 120 hours each side from midnight UTC, the after
    // window ending with today.
    expect(defaultCompare(now)).toEqual({
      at: Date.UTC(2030, 0, 16),
      hours: 120,
      source: 'all',
    })
    for (const hash of [
      '#/compare',
      '#/compare?at=2030-01-20T13:00Z&hours=9',
      '#/compare?at=2030-02-30T10:00Z&hours=0',
      '#/compare?at=2030-01-08T14:30Z&hours=7',
      '#/compare?at=2030-01-08&hours=x',
      '#/compare?date=2030-01-08&days=3',
    ])
      expect(parseRoute(hash, now).compare, hash).toEqual(defaultCompare(now))
    // An unknown length alone falls back to the default length.
    expect(
      parseRoute('#/compare?at=2030-01-08T14:00Z&hours=7', now).compare,
    ).toEqual({ at: Date.UTC(2030, 0, 8, 14), hours: 120, source: 'all' })
  })

  it('formats the compare view with its own parameters', () => {
    expect(
      formatRoute({
        view: 'compare',
        window: '7d',
        compare: { at: Date.UTC(2030, 0, 8, 14), hours: 24, source: 'all' },
      }),
    ).toBe('#/compare?at=2030-01-08T14:00Z&hours=24')
    expect(
      formatRoute({
        view: 'compare',
        window: '7d',
        compare: {
          at: Date.UTC(2030, 0, 8, 14),
          hours: 48,
          source: 'N2KAnalyzerOut',
        },
      }),
    ).toBe('#/compare?at=2030-01-08T14:00Z&hours=48&source=N2KAnalyzerOut')
  })
})
