import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { destination } from '../src/geo'
import { paths } from '../src/paths'
import { PLUGIN_ID, createPlugin } from '../src/plugin'
import { asOwn, classA, classB, OWN, staticA } from './fixtures/ais'
import { fakeApp } from './fixtures/app'
import { classAPgn, staticAPgn } from './fixtures/n2k'
import { FakeHistory } from './fixtures/history'
import { fakeRouter } from './fixtures/router'

const T0 = Date.UTC(2030, 0, 1, 12, 0, 30)

function sentenceAt(mmsi: number, bearing: number, nm: number, b = false) {
  const p = destination(OWN, bearing, nm)
  return b ? classB(mmsi, p.lat, p.lon) : classA(mmsi, p.lat, p.lon)
}

describe('plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'Date',
        'setTimeout',
        'setInterval',
        'clearTimeout',
        'clearInterval',
      ],
    })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it('ingests sentences, publishes every interval and serves routes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ais-plugin-'))
    const f = fakeApp(dir, new FakeHistory())
    const plugin = createPlugin(f.app as never)
    const r = fakeRouter()
    plugin.registerWithRouter!(r.router as never)
    await plugin.start({}, () => undefined)

    f.position(OWN.lat, OWN.lon)
    f.app.emit('nmea0183', sentenceAt(999000001, 50, 12))
    f.app.emit('nmea0183', sentenceAt(999000002, 205, 25, true))
    f.app.emit('nmea0183', asOwn(sentenceAt(999000003, 0, 1)))
    f.app.emit('nmea0183', '!AIVDM,garbage')
    f.app.emit('nmea0183', 42)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(f.deltas.length).toBe(1)
    expect(f.deltas[0]!.id).toBe(PLUGIN_ID)
    const values = new Map(
      f.deltas[0]!.delta.updates[0]!.values.map((v) => [v.path, v.value]),
    )
    expect(values.get(paths.messagesTotal)).toBe(2)
    expect(values.get(paths.positionsClassB)).toBe(1)
    expect(values.get(paths.coverageCellsToday)).toBe(2)
    expect(values.get(paths.distanceMax)).toBeCloseTo(25 * 1852, -1)
    expect(f.metadata.get(paths.distanceMax)?.units).toBe('m')

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(f.deltas.length).toBe(2)

    const status = (await r.call('/status')).body as Record<string, unknown>
    expect(status).toMatchObject({
      running: true,
      noData: false,
      trackedTargets: 2,
      ownSentencesSkipped: 1,
      historyAvailable: true,
    })
    const summary = (await r.call('/summary', { window: '1h' })).body as {
      messages: number
    }
    expect(summary.messages).toBe(2)
    const overlay = (await r.call('/overlay/coverage.geojson')).body as {
      features: { properties: { kind: string } }[]
    }
    const kinds = overlay.features.map((x) => x.properties.kind).sort()
    expect(kinds.filter((k) => k === 'cell')).toHaveLength(2)
    // One report per sector is too sparse for a sector wedge.
    expect(kinds).not.toContain('sector')

    await plugin.stop()
    expect(f.app.listenerCount('nmea0183')).toBe(0)
    expect(f.positionListeners.size).toBe(0)
    expect((await readdir(dir)).sort()).toEqual([
      'coverage-2030-01-01.json',
      'longrange-2030-01-01.json',
    ])
    expect((await r.call('/summary')).status).toBe(503)
    expect(f.errors).toEqual([])
  })

  it('files coverage under the own vessel mode at reception', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ais-plugin-'))
    const f = fakeApp(dir)
    const plugin = createPlugin(f.app as never)
    const r = fakeRouter()
    plugin.registerWithRouter!(r.router as never)
    await plugin.start({}, () => undefined)
    type Cov = { cells: number }
    const cells = async (mode: string) =>
      ((await r.call('/coverage', { mode })).body as Cov).cells

    f.position(OWN.lat, OWN.lon)
    expect((await r.call('/status')).body).toMatchObject({
      mode: 'unknown',
      modeSource: null,
    })
    f.app.emit('nmea0183', sentenceAt(999000001, 50, 12))
    f.navState('moored')
    expect((await r.call('/status')).body).toMatchObject({
      mode: 'stationary',
      modeSource: 'state',
    })
    f.app.emit('nmea0183', sentenceAt(999000002, 150, 12))
    f.navState('sailing')
    f.app.emit('nmea0183', sentenceAt(999000003, 250, 12))
    f.app.emit('nmea0183', sentenceAt(999000004, 320, 12))
    expect(await cells('all')).toBe(4)
    expect(await cells('stationary')).toBe(1)
    expect(await cells('underway')).toBe(2)

    // Without a state, ten minutes in one place make it stationary by drift.
    f.navState('default')
    for (let i = 0; i < 11 * 60; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      f.position(OWN.lat, OWN.lon)
    }
    expect((await r.call('/status')).body).toMatchObject({
      mode: 'stationary',
      modeSource: 'drift',
    })

    await plugin.stop()
    expect(f.selfListeners.get('navigation.state')?.size).toBe(0)
  })

  it('saves live settings into the stored config and applies them', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    const options = {
      publishIntervalMinutes: 10,
      coverageDistancePercentile: 99,
      sentenceEvents: ['nmea0183'],
      someFutureOption: 'kept',
    }
    f.stored.configuration = options
    const plugin = createPlugin(f.app as never)
    const r = fakeRouter()
    plugin.registerWithRouter!(r.router as never)
    await plugin.start(options, () => undefined)
    const res = await r.post('/settings', { coverageDistancePercentile: 95 })
    expect(res).toMatchObject({
      status: 200,
      body: { settings: { coverageDistancePercentile: 95 } },
    })
    // Merged, not replaced: the server stores the whole object it is given.
    expect(f.saves).toEqual([{ ...options, coverageDistancePercentile: 95 }])
    const status = (await r.call('/status')).body as {
      config: Record<string, unknown>
    }
    expect(status.config).toMatchObject({
      coverageDistancePercentile: 95,
      publishIntervalMinutes: 10,
    })
    await plugin.stop()
  })

  it('counts AIS from NMEA 2000 by default', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    const plugin = createPlugin(f.app as never)
    const r = fakeRouter()
    plugin.registerWithRouter!(r.router as never)
    await plugin.start({}, () => undefined)
    f.position(OWN.lat, OWN.lon)
    const p = destination(OWN, 90, 10)
    f.app.emit('N2KAnalyzerOut', classAPgn(999000001, p.lat, p.lon))
    f.app.emit('N2KAnalyzerOut', staticAPgn(999000001, 'Tanker'))
    f.app.emit(
      'N2KAnalyzerOut',
      classAPgn(999000002, p.lat, p.lon, 'Channel A VDL transmission'),
    )
    f.app.emit('N2KAnalyzerOut', { pgn: 127250, fields: {} })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const values = new Map(
      f.deltas[0]!.delta.updates[0]!.values.map((v) => [v.path, v.value]),
    )
    expect(values.get(paths.messagesTotal)).toBe(2)
    expect(values.get(paths.distanceMax)).toBeCloseTo(10 * 1852, -1)
    expect((await r.call('/status')).body).toMatchObject({
      sentences: 3,
      ownSentencesSkipped: 1,
      decodeErrors: 0,
    })
    await plugin.stop()
    expect(f.app.listenerCount('N2KAnalyzerOut')).toBe(0)
  })

  it('also counts AIS from nmea0183AISout, decoding each source apart', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    const plugin = createPlugin(f.app as never)
    const r = fakeRouter()
    plugin.registerWithRouter!(r.router as never)
    await plugin.start(
      { sentenceEvents: ['nmea0183', 'nmea0183AISout'] },
      () => undefined,
    )
    f.app.emit('nmea0183AISout', sentenceAt(999000001, 50, 12))
    // The same multipart message on both events, interleaved.
    const [a1, a2] = staticA(999000002, 70)
    f.app.emit('nmea0183', a1)
    f.app.emit('nmea0183AISout', a1)
    f.app.emit('nmea0183', a2)
    f.app.emit('nmea0183AISout', a2)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const values = new Map(
      f.deltas[0]!.delta.updates[0]!.values.map((v) => [v.path, v.value]),
    )
    expect(values.get(paths.messagesTotal)).toBe(3)
    expect((await r.call('/status')).body).toMatchObject({
      sentences: 5,
      decodeErrors: 0,
    })
    await plugin.stop()
    expect(f.app.listenerCount('nmea0183')).toBe(0)
    expect(f.app.listenerCount('nmea0183AISout')).toBe(0)
  })

  it('counts message health across events and keeps every message', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    const plugin = createPlugin(f.app as never)
    const r = fakeRouter()
    plugin.registerWithRouter!(r.router as never)
    await plugin.start({}, () => undefined)
    f.position(OWN.lat, OWN.lon)
    const p = destination(OWN, 90, 10)
    // One receiver reaching both default events: a cross-event copy.
    f.app.emit('nmea0183', classA(999000001, p.lat, p.lon))
    f.app.emit('N2KAnalyzerOut', classAPgn(999000001, p.lat, p.lon))
    // The same sentence twice on one event.
    f.app.emit('nmea0183', classA(999000002, p.lat, p.lon))
    f.app.emit('nmea0183', classA(999000002, p.lat, p.lon))
    f.app.emit('nmea0183', '!AIVDM,1,1,,A,13u?etPv2;0n:dDPwUM1U1Cb069D,0*00')
    f.app.emit('nmea0183', classA(999000003, undefined, undefined))
    // A vessel 50 nm away ten seconds later.
    vi.advanceTimersByTime(10_000)
    const q = destination(OWN, 90, 60)
    f.app.emit('nmea0183', classA(999000002, q.lat, q.lon))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const values = new Map(
      f.deltas[0]!.delta.updates[0]!.values.map((v) => [v.path, v.value]),
    )
    expect(values.get(paths.messagesTotal)).toBe(6)
    expect(values.get(paths.healthDuplicatesCrossEvent)).toBe(1)
    expect(values.get(paths.healthDuplicates)).toBe(1)
    expect(values.get(paths.healthDecodeErrors)).toBe(1)
    expect(values.get(paths.healthPositionInvalid)).toBe(1)
    expect(values.get(paths.healthImplausibleJumps)).toBe(1)
    expect(values.get(paths.healthNoOwnPosition)).toBe(0)
    const lr = (await r.call('/longrange', { window: '24h' })).body as {
      fastest: unknown[]
      implausibleJumps: { mmsi: string; implausible: boolean }[]
    }
    expect(lr.fastest).toEqual([])
    expect(lr.implausibleJumps).toMatchObject([
      { mmsi: '999000002', implausible: true },
    ])
    const summary = (await r.call('/summary', { window: '1h' })).body as {
      health: { received: number }
    }
    expect(summary.health.received).toBe(7)
    await plugin.stop()
  })

  it('listens only on the configured sentence events', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    const plugin = createPlugin(f.app as never)
    await plugin.start({ sentenceEvents: ['myAisOut'] }, () => undefined)
    expect(f.app.listenerCount('nmea0183')).toBe(0)
    expect(f.app.listenerCount('nmea0183AISout')).toBe(0)
    f.app.emit('nmea0183', sentenceAt(999000001, 50, 12))
    f.app.emit('myAisOut', sentenceAt(999000002, 50, 12))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const values = new Map(
      f.deltas[0]!.delta.updates[0]!.values.map((v) => [v.path, v.value]),
    )
    expect(values.get(paths.messagesTotal)).toBe(1)
    await plugin.stop()
    expect(f.app.listenerCount('myAisOut')).toBe(0)
  })

  it('starts and stops in an app shaped like the registry harness', async () => {
    // The registry's shim: no-op events, a stream whose onValue returns the
    // bus rather than an unsubscribe function, no History API, and no call
    // to registerWithRouter.
    const dir = await mkdtemp(join(tmpdir(), 'ais-plugin-'))
    const errors: string[] = []
    const bus = { onValue: () => bus }
    const app = {
      on: () => undefined,
      removeListener: () => undefined,
      streambundle: { getSelfStream: () => bus },
      handleMessage: () => undefined,
      getDataDirPath: () => dir,
      registerResourceProvider: () => undefined,
      setPluginStatus: () => undefined,
      setPluginError: (s: string) => errors.push(s),
      error: (s: string) => errors.push(s),
      debug: () => undefined,
    }
    const plugin = createPlugin(app as never)
    expect(typeof plugin.schema).toBe('function')
    await plugin.start({}, () => undefined)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await plugin.stop()
    expect(errors).toEqual([])
  })

  it('publishes every 5 minutes, with sector paths once an hour', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    const plugin = createPlugin(f.app as never)
    await plugin.start({}, () => undefined)
    const hasSectors = (i: number) =>
      f.deltas[i]!.delta.updates[0]!.values.some((v) =>
        v.path.includes('.sectors.'),
      )
    // T0 is 12:00:30; ticks fall at 12:04:59, 12:09:59 ... 12:59:59.
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(f.deltas).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.deltas).toHaveLength(1)
    expect(hasSectors(0)).toBe(true)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(f.deltas).toHaveLength(2)
    expect(hasSectors(1)).toBe(false)
    await vi.advanceTimersByTimeAsync(50 * 60_000)
    expect(f.deltas).toHaveLength(12)
    expect(hasSectors(10)).toBe(false)
    // The tick that closes the hour carries them again.
    expect(hasSectors(11)).toBe(true)
    await plugin.stop()
  })

  it('publishes at the configured interval', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    const plugin = createPlugin(f.app as never)
    await plugin.start({ publishIntervalMinutes: 1 }, () => undefined)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(f.deltas).toHaveLength(3)
    await plugin.stop()
  })

  it('counts reports without own position toward rates only', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    const plugin = createPlugin(f.app as never)
    await plugin.start({}, () => undefined)
    f.app.emit('nmea0183', sentenceAt(999000001, 50, 12))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const values = new Map(
      f.deltas[0]!.delta.updates[0]!.values.map((v) => [v.path, v.value]),
    )
    expect(values.get(paths.positionsClassA)).toBe(1)
    expect(values.has(paths.distanceP99)).toBe(false)
    expect(values.get(paths.coverageCellsToday)).toBe(0)
    await plugin.stop()
  })

  it('finds a history provider that registers after the plugin starts', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    let ready = false
    const history = new FakeHistory()
    ;(f.app as Record<string, unknown>).getHistoryApi = () =>
      ready ? Promise.resolve(history) : Promise.reject(new Error('none'))
    const plugin = createPlugin(f.app as never)
    const r = fakeRouter()
    plugin.registerWithRouter!(r.router as never)
    await plugin.start({}, () => undefined)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await r.call('/status')).body).toMatchObject({
      historyAvailable: false,
    })
    ready = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await r.call('/status')).body).toMatchObject({
      historyAvailable: true,
    })
    await plugin.stop()
  })

  it('serves the overlay manifest only while running', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    const plugin = createPlugin(f.app as never)
    await plugin.start({}, () => undefined)
    expect(f.providers).toHaveLength(1)
    const p = f.providers[0]!
    expect(p.type).toBe('plotterExtensions')
    const list = (await p.methods.listResources!()) as Record<string, unknown>
    expect(Object.keys(list)).toEqual([PLUGIN_ID])
    await expect(p.methods.setResource!()).rejects.toThrow()
    await plugin.stop()
    expect(await p.methods.listResources!()).toEqual({})
    await expect(p.methods.getResource!(PLUGIN_ID)).rejects.toThrow()
    // A restart does not register a second provider.
    await plugin.start({}, () => undefined)
    expect(f.providers).toHaveLength(1)
    await plugin.stop()
  })

  it('does not offer the overlay when disabled', async () => {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-plugin-')))
    const plugin = createPlugin(f.app as never)
    await plugin.start({ publishOverlay: false }, () => undefined)
    expect(f.providers).toHaveLength(0)
    await plugin.stop()
  })

  it('has a config schema with defaults', () => {
    const plugin = createPlugin({} as never)
    const schema = (plugin.schema as () => { properties: object })()
    expect(Object.keys(schema.properties)).toContain('h3Resolution')
  })
})
