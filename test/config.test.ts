import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, configSchema, resolveConfig } from '../src/config'

describe('resolveConfig', () => {
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
    })
    expect(c.h3Resolution).toBe(8)
    expect(c.coverageDistancePercentile).toBe(100)
    expect(c.targetExpirySeconds).toBe(60)
    expect(c.publishOverlay).toBe(false)
  })

  it('ignores values of the wrong type', () => {
    const c = resolveConfig({ h3Resolution: 'x', publishOverlay: 'no' })
    expect(c.h3Resolution).toBe(DEFAULT_CONFIG.h3Resolution)
    expect(c.publishOverlay).toBe(true)
  })

  it('has a schema default for every option', () => {
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      const prop = (
        configSchema.properties as Record<string, { default: unknown }>
      )[key]
      expect(prop?.default).toBe(value)
    }
  })
})
