import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  LIVE_SETTINGS,
  MAX_WEATHER_PATHS,
  configSchema,
  liveBounds,
  parseLiveSettings,
  resolveConfig,
} from '../src/config'

describe('weatherPaths', () => {
  it('defaults to the standard weather paths', () => {
    expect(resolveConfig({}).weatherPaths).toEqual([
      'environment.outside.pressure',
      'environment.outside.temperature',
      'environment.outside.relativeHumidity',
      'environment.water.temperature',
    ])
  })

  it('trims, drops duplicates, wildcards and bad names', () => {
    const c = resolveConfig({
      weatherPaths: [
        ' environment.outside.pressure ',
        'environment.outside.pressure',
        'environment.*.temperature',
        'environment..wind',
        '',
        7,
        'environment.wind.speedTrue',
      ],
    })
    expect(c.weatherPaths).toEqual([
      'environment.outside.pressure',
      'environment.wind.speedTrue',
    ])
  })

  it('keeps at most eight, so one history request reads them', () => {
    const many = Array.from({ length: 12 }, (_, i) => `environment.p${i}`)
    const c = resolveConfig({ weatherPaths: many })
    expect(MAX_WEATHER_PATHS).toBe(8)
    expect(c.weatherPaths).toEqual(many.slice(0, 8))
  })

  it('accepts an empty list, which hides the panel', () => {
    expect(resolveConfig({ weatherPaths: [] }).weatherPaths).toEqual([])
    expect(resolveConfig({ weatherPaths: 'x' }).weatherPaths).toEqual(
      DEFAULT_CONFIG.weatherPaths,
    )
  })
})

describe('resolveConfig', () => {
  it('defaults to H3 resolution 6, cells about 7 km across', () => {
    expect(DEFAULT_CONFIG.h3Resolution).toBe(6)
  })

  it('returns the defaults for missing options', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it('keeps valid values and clamps out-of-range ones', () => {
    const c = resolveConfig({
      h3Resolution: 12,
      coverageDistancePercentile: 100,
      targetExpirySeconds: 5,
      publishOverlay: false,
      sentenceEvents: ['nmea0183AISout', ' myAisOut ', 'nmea0183AISout', 3, ''],
    })
    expect(c.h3Resolution).toBe(8)
    expect(c.coverageDistancePercentile).toBe(100)
    expect(c.targetExpirySeconds).toBe(60)
    expect(c.publishOverlay).toBe(false)
    expect(c.sentenceEvents).toEqual(['nmea0183AISout', 'myAisOut'])
  })

  it('ignores values of the wrong type', () => {
    const c = resolveConfig({
      h3Resolution: 'x',
      publishOverlay: 'no',
      sentenceEvents: 'nmea0183',
    })
    expect(c.sentenceEvents).toEqual(['nmea0183', 'N2KAnalyzerOut'])
    expect(c.h3Resolution).toBe(DEFAULT_CONFIG.h3Resolution)
    expect(c.publishOverlay).toBe(true)
  })

  it('detects stationary within 200 m for 10 minutes by default, within bounds', () => {
    expect(DEFAULT_CONFIG.modeDriftRadiusMeters).toBe(200)
    expect(DEFAULT_CONFIG.modeDriftMinutes).toBe(10)
    const low = resolveConfig({ modeDriftRadiusMeters: 1, modeDriftMinutes: 0 })
    expect(low.modeDriftRadiusMeters).toBe(50)
    expect(low.modeDriftMinutes).toBe(2)
    const high = resolveConfig({
      modeDriftRadiusMeters: 1e6,
      modeDriftMinutes: 600,
    })
    expect(high.modeDriftRadiusMeters).toBe(2000)
    expect(high.modeDriftMinutes).toBe(60)
    expect(
      resolveConfig({ modeDriftRadiusMeters: 350 }).modeDriftRadiusMeters,
    ).toBe(350)
  })

  it('publishes every 5 minutes and keeps coverage for 14 days by default', () => {
    expect(DEFAULT_CONFIG.publishIntervalMinutes).toBe(5)
    expect(DEFAULT_CONFIG.coverageRetentionDays).toBe(14)
  })

  it('snaps the publish interval to a divisor of the hour', () => {
    expect(
      resolveConfig({ publishIntervalMinutes: 7 }).publishIntervalMinutes,
    ).toBe(6)
    expect(
      resolveConfig({ publishIntervalMinutes: 15 }).publishIntervalMinutes,
    ).toBe(15)
    expect(
      resolveConfig({ publishIntervalMinutes: 0 }).publishIntervalMinutes,
    ).toBe(1)
    expect(
      resolveConfig({ publishIntervalMinutes: 500 }).publishIntervalMinutes,
    ).toBe(60)
    expect(
      resolveConfig({ publishIntervalMinutes: 'x' }).publishIntervalMinutes,
    ).toBe(5)
  })

  it('has a schema default for every option', () => {
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      const prop = (
        configSchema.properties as Record<string, { default: unknown }>
      )[key]
      expect(prop?.default).toEqual(value)
    }
  })

  it('bounds every live setting the same way as resolveConfig', () => {
    for (const key of LIVE_SETTINGS) {
      const { min, max } = liveBounds(key)
      expect(Number.isFinite(min) && Number.isFinite(max), key).toBe(true)
      expect(resolveConfig({ [key]: min - 1 })[key]).toBe(min)
      expect(resolveConfig({ [key]: max + 1 })[key]).toBe(max)
      expect(parseLiveSettings({ [key]: min })).toEqual({ [key]: min })
      expect(parseLiveSettings({ [key]: max })).toEqual({ [key]: max })
      expect(() => parseLiveSettings({ [key]: min - 0.1 })).toThrow()
      expect(() => parseLiveSettings({ [key]: max + 0.1 })).toThrow()
    }
  })
})
