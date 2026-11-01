import { describe, expect, it } from 'vitest'
import {
  bannerText,
  stateText,
  trial,
  trialText,
  type Propagation,
} from '../../web/src/propagation'

const T0 = Date.UTC(2030, 0, 1, 12)

function status(
  over: Partial<Extract<Propagation, { enabled: true }>> = {},
): Extract<Propagation, { enabled: true }> {
  return {
    enabled: true,
    state: 'normal',
    ratio: 1.1,
    p99M: 22000,
    baselineM: 20000,
    baselineHours: 120,
    vessels: 0,
    sectors: [],
    since: null,
    mode: 'unknown',
    rule: { factor: 2, minVessels: 3, sustainMinutes: 15, windowMinutes: 15 },
    checks: [],
    ...over,
  }
}

/** Minutes of checks: `met` minutes at 2.5 times with 4 vessels, then normal. */
function checks(met: number, after = 0) {
  return Array.from({ length: met + after }, (_, m) => ({
    time: new Date(T0 + m * 60_000).toISOString(),
    armed: true,
    ratio: m < met ? 2.5 : 1,
    vessels: m < met ? 4 : 0,
  }))
}

describe('propagation alert in the web app', () => {
  it('shows the banner only while the notification is not normal', () => {
    expect(bannerText(undefined)).toBeUndefined()
    expect(bannerText({ state: 'normal', message: 'x' })).toBeUndefined()
    expect(bannerText({ state: 'warn', message: 'AIS range 2.4 times' })).toBe(
      'AIS range 2.4 times',
    )
    expect(bannerText({ state: 'alarm' })).toMatch(/above normal/)
  })

  it('describes each state', () => {
    const fmt = (m: number) => `${m / 1000} km`
    const t = (ms: number) => new Date(ms).toISOString()
    expect(
      stateText(status({ state: 'unarmed', baselineHours: 7 }), fmt, t),
    ).toMatch(/7 of 24 hours/)
    expect(stateText(status(), fmt, t)).toBe(
      'No alert. Normal p99 20 km, now 1.1 times that.',
    )
    expect(
      stateText(
        status({
          state: 'alert',
          ratio: 2.6,
          since: new Date(T0).toISOString(),
        }),
        fmt,
        t,
      ),
    ).toBe(`Alert since ${new Date(T0).toISOString()}: range 2.6 times normal.`)
    expect(
      stateText(status({ state: 'suppressed', ratio: 3 }), fmt, t),
    ).toMatch(/underway/)
  })

  it('replays the last hour of checks with trial settings', () => {
    const p = status({ checks: checks(20) })
    const rule = { factor: 2, minVessels: 3, sustainMinutes: 15 }
    expect(trial(p, rule)).toEqual({
      active: true,
      metMinutes: 20,
      minutes: 20,
    })
    expect(trial(p, { ...rule, sustainMinutes: 30 }).active).toBe(false)
    expect(trial(p, { ...rule, factor: 3 })).toMatchObject({
      active: false,
      metMinutes: 0,
    })
    expect(trial(p, { ...rule, minVessels: 5 }).active).toBe(false)
    // Cleared once the conditions failed for the duration.
    expect(trial(status({ checks: checks(20, 16) }), rule).active).toBe(false)
    expect(trial(status({ checks: checks(20, 10) }), rule).active).toBe(true)
  })

  it('says what a trial would do', () => {
    expect(trialText({ active: false, metMinutes: 0, minutes: 0 })).toMatch(
      /No checks yet/,
    )
    expect(trialText({ active: true, metMinutes: 20, minutes: 60 })).toBe(
      'With these settings, over the last 60 minutes the conditions held for 20, and an alert would be active now.',
    )
  })
})
