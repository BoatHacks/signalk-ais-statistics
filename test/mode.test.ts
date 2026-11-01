import { describe, expect, it } from 'vitest'
import { destination } from '../src/geo'
import { M_PER_NM } from '../src/geo'
import { MAX_DRIFT_SAMPLES, VesselMode, modeOfState } from '../src/mode'

// An arbitrary open-sea point; offsets in metres.
const SEA = { lat: 40, lon: -30 }
const T0 = Date.UTC(2030, 0, 1, 12)
const S = 1000
const MIN = 60 * S

function at(bearing: number, metres: number) {
  const p = destination(SEA, bearing, metres / M_PER_NM)
  return { latitude: p.lat, longitude: p.lon }
}

function mode(radiusM = 200, minutes = 10, maxGapS = 60) {
  return new VesselMode({
    radiusM,
    windowMs: minutes * MIN,
    maxGapMs: maxGapS * S,
  })
}

/** Feeds a position every second from `from` for `ms`, from `place(t)`. */
function feed(
  m: VesselMode,
  from: number,
  ms: number,
  place: (t: number) => { latitude: number; longitude: number },
): number {
  for (let t = from; t < from + ms; t += S) m.position(place(t), t)
  return from + ms
}

describe('modeOfState', () => {
  it('maps the stationary states of the SignalK schema', () => {
    for (const s of ['anchored', 'moored', 'not-under-way', 'aground'])
      expect(modeOfState(s), s).toBe('stationary')
    expect(modeOfState('not under way')).toBe('stationary')
    expect(modeOfState('Moored')).toBe('stationary')
  })

  it('maps the movement states of the schema', () => {
    for (const s of [
      'sailing',
      'motoring',
      'towing < 200m',
      'towing > 200m',
      'pushing',
      'fishing',
      'fishing-hampered',
      'trawling',
      'trawling-shooting',
      'trawling-hauling',
      'pilotage',
      'restricted manouverability',
      'restricted manouverability towing < 200m',
      'restricted manouverability underwater operations',
      'constrained by draft',
      'mine clearance',
    ])
      expect(modeOfState(s), s).toBe('underway')
  })

  it('accepts the corrected manoeuvrability spellings too', () => {
    expect(modeOfState('restricted manoeuvrability')).toBe('underway')
    expect(modeOfState('restricted maneuverability towing > 200m')).toBe(
      'underway',
    )
  })

  it('leaves values that say nothing about movement to drift', () => {
    for (const s of [
      'default',
      'not under command',
      'Reserved for future use-13',
      'ais-sart',
      '',
      'mooredx',
      null,
      undefined,
      3,
    ])
      expect(modeOfState(s), String(s)).toBeUndefined()
  })
})

describe('VesselMode', () => {
  it('is unknown with no data', () => {
    const m = mode()
    expect(m.current(T0)).toBe('unknown')
    expect(m.source(T0)).toBeNull()
  })

  it('turns stationary once the position stays within the radius for the window', () => {
    const m = mode()
    let t = feed(m, T0, 9 * MIN, () => at(0, 0))
    expect(m.current(t)).toBe('unknown')
    t = feed(m, t, 1 * MIN + 10 * S, (u) => at((u / S) * 7, 150))
    expect(m.current(t)).toBe('stationary')
    expect(m.source(t)).toBe('drift')
  })

  it('stays stationary while swinging around an anchor', () => {
    const m = mode()
    // Swinging on a 60 m rode, a full circle every 20 minutes.
    const swing = (t: number) => at((((t - T0) / (20 * MIN)) * 360) % 360, 60)
    let t = feed(m, T0, 11 * MIN, swing)
    expect(m.current(t)).toBe('stationary')
    t = feed(m, t, 3 * 60 * MIN, swing)
    expect(m.current(t)).toBe('stationary')
  })

  it('turns underway as soon as a position leaves the radius', () => {
    const m = mode()
    let t = feed(m, T0, 11 * MIN, () => at(0, 0))
    expect(m.current(t)).toBe('stationary')
    m.position(at(90, 250), t)
    expect(m.current(t)).toBe('underway')
    // Back inside the old radius, it stays underway until a full window
    // has passed again.
    t = feed(m, t + S, 5 * MIN, () => at(0, 0))
    expect(m.current(t)).toBe('underway')
    t = feed(m, t, 6 * MIN, () => at(0, 0))
    expect(m.current(t)).toBe('stationary')
  })

  it('is underway when the window is full and the track spreads past the radius', () => {
    const m = mode()
    // 3 knots, about 1.5 m/s.
    const t = feed(m, T0, 11 * MIN, (u) => at(45, ((u - T0) / S) * 1.5))
    expect(m.current(t)).toBe('underway')
    expect(m.source(t)).toBe('drift')
  })

  it('is unknown after a gap in own positions and until the window refills', () => {
    const m = mode()
    let t = feed(m, T0, 11 * MIN, () => at(0, 0))
    expect(m.current(t)).toBe('stationary')
    // No positions: stale after the maximum age.
    expect(m.current(t + 61 * S)).toBe('unknown')
    expect(m.source(t + 61 * S)).toBeNull()
    t += 5 * MIN
    t = feed(m, t, 5 * MIN, () => at(0, 0))
    expect(m.current(t)).toBe('unknown')
    t = feed(m, t, 6 * MIN, () => at(0, 0))
    expect(m.current(t)).toBe('stationary')
  })

  it('follows the thresholds', () => {
    const m = mode(500, 2)
    const t = feed(m, T0, 2 * MIN + 10 * S, (u) => at((u / S) * 13, 400))
    expect(m.current(t)).toBe('stationary')
  })

  it('lets a recognised navigation.state decide over drift', () => {
    const m = mode()
    const t = feed(m, T0, 11 * MIN, () => at(0, 0))
    m.setState('motoring')
    expect(m.current(t)).toBe('underway')
    expect(m.source(t)).toBe('state')
    // Trusted even when the positions say otherwise, and without positions.
    m.setState('moored')
    m.position(at(90, 5000), t + S)
    expect(m.current(t + S)).toBe('stationary')
    expect(m.current(t + 3600 * S)).toBe('stationary')
    expect(m.source(t + 3600 * S)).toBe('state')
  })

  it('hands back to drift when the state is unrecognised or cleared', () => {
    const m = mode()
    const t = feed(m, T0, 11 * MIN, () => at(0, 0))
    m.setState('sailing')
    m.setState('default')
    expect(m.current(t)).toBe('stationary')
    expect(m.source(t)).toBe('drift')
    m.setState('sailing')
    m.setState(null)
    expect(m.source(t)).toBe('drift')
  })

  it('ignores invalid positions', () => {
    const m = mode()
    for (const p of [
      null,
      'x',
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: NaN },
      { latitude: '1', longitude: 2 },
    ])
      m.position(p, T0)
    expect(m.sampleCount()).toBe(0)
    expect(m.current(T0)).toBe('unknown')
  })

  it('holds a bounded number of samples', () => {
    for (const minutes of [2, 10, 60]) {
      const m = mode(200, minutes)
      feed(m, T0, 3 * 60 * MIN, () => at(0, 0))
      expect(m.sampleCount(), `${minutes} min`).toBeLessThanOrEqual(
        MAX_DRIFT_SAMPLES + 1,
      )
    }
  })
})
