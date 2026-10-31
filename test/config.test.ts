import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, configSchema, resolveConfig } from '../src/config'

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
})
