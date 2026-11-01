// Per-source statistics (#14): labels, the per-event aggregators, their
// counters in history, and the plugin wiring with the option on and off.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOUR_MS, MINUTE_MS } from '../src/aggregate'
import { DEFAULT_CONFIG, configSchema, resolveConfig } from '../src/config'
import { destination } from '../src/geo'
import { HistoryApiReader } from '../src/history'
import {
  DISTANCE_BIN_COUNT,
  HEALTH_KINDS,
  PATH_PREFIX,
  counterPaths,
  paths,
  sourceLabel,
  sourceLabels,
  sourcePaths,
} from '../src/paths'
import { PLUGIN_ID, createPlugin } from '../src/plugin'
import { Query } from '../src/query'
import { Sources } from '../src/sources'
import { OWN, classA } from './fixtures/ais'
import { fakeApp } from './fixtures/app'
import { classAPgn } from './fixtures/n2k'
import { FakeHistory } from './fixtures/history'
import { fakeRouter } from './fixtures/router'

const T0 = Date.UTC(2030, 0, 1)

function report(mmsi: number, bearing: number, nm: number) {
  const p = destination(OWN, bearing, nm)
  return { type: 1, mmsi: String(mmsi), lat: p.lat, lon: p.lon }
}

describe('source labels', () => {
  it('keeps letters and digits and maps the rest to _', () => {
    expect(sourceLabel('nmea0183')).toBe('nmea0183')
    expect(sourceLabel('N2KAnalyzerOut')).toBe('N2KAnalyzerOut')
    expect(sourceLabel('my-ais.out 2')).toBe('my_ais_out_2')
    expect(sourceLabel('')).toBe('_')
  })

  it('numbers labels that collide, in config order', () => {
    const { labels, collisions } = sourceLabels([
      'a-b',
      'a.b',
      'a_b',
      'c',
      'a-b',
    ])
    expect([...labels]).toEqual([
      ['a-b', 'a_b'],
      ['a.b', 'a_b_2'],
      ['a_b', 'a_b_3'],
      ['c', 'c'],
    ])
    expect(collisions).toEqual(['a.b', 'a_b'])
  })

  it('puts the source counters under sources.<label>, in query order', () => {
    const s = sourcePaths('nmea0183')
    expect(s.messagesTotal).toBe(
      `${PATH_PREFIX}.sources.nmea0183.messages.total`,
    )
    expect(s.distanceBin(7)).toBe(
      `${PATH_PREFIX}.sources.nmea0183.distance.bin.07`,
    )
    expect(s.health('duplicatesCrossEvent')).toBe(
      `${PATH_PREFIX}.sources.nmea0183.health.duplicatesCrossEvent`,
    )
    const main = counterPaths()
    const src = counterPaths('nmea0183')
    expect(src).toHaveLength(4 + DISTANCE_BIN_COUNT + HEALTH_KINDS.length)
    expect(main).toHaveLength(src.length)
    expect(main[0]).toBe(paths.messagesTotal)
    // Same order: each source path ends like its main counterpart.
    src.forEach((p, i) =>
      expect(p.replace('.sources.nmea0183', '')).toBe(main[i]),
    )
  })
})

describe('Sources', () => {
  it('counts each event apart and publishes 43 counters per source', () => {
    const sources = new Sources(['nmea0183', 'N2KAnalyzerOut'], T0)
    const a = sources.event('nmea0183')!.agg
    const b = sources.event('N2KAnalyzerOut')!.agg
    a.add(report(999000001, 50, 10), OWN, T0 + 1000)
    a.add(report(999000002, 50, 20), OWN, T0 + 2000)
    b.add(report(999000001, 50, 10), OWN, T0 + 1000)
    b.countHealth('duplicatesCrossEvent', T0 + 1000)
    const values = new Map(sources.values().map((v) => [v.path, v.value]))
    expect(values.size).toBe(2 * 43)
    const pa = sourcePaths('nmea0183')
    const pb = sourcePaths('N2KAnalyzerOut')
    expect(values.get(pa.messagesTotal)).toBe(2)
    expect(values.get(pb.messagesTotal)).toBe(1)
    expect(values.get(pb.health('duplicatesCrossEvent'))).toBe(1)
    expect(values.get(pa.health('duplicatesCrossEvent'))).toBe(0)
    expect(sources.label('N2KAnalyzerOut')?.event).toBe('N2KAnalyzerOut')
  })

  it('answers a source window from its counters in history', async () => {
    const history = new FakeHistory()
    const sources = new Sources(['near', 'far'], T0)
    const near = sources.event('near')!
    const far = sources.event('far')!
    for (let m = 0; m < 120; m++) {
      const t = T0 + m * MINUTE_MS
      near.agg.add(report(999000001, 50, 5), OWN, t + 1000)
      far.agg.add(report(999000001, 50, 5), OWN, t + 1000)
      far.agg.add(report(999000002, 200, 40), OWN, t + 2000)
      history.record(sources.values(), t + 59_000)
    }
    const now = T0 + 120 * MINUTE_MS
    const q = (s: typeof near) =>
      new Query(
        s.agg,
        () => new HistoryApiReader(history),
        60,
        undefined,
        undefined,
        () => [],
        { counters: s.counters },
      )
    const range = { from: T0, to: T0 + 2 * HOUR_MS }
    const n = await q(near).summary(range, now)
    const f = await q(far).summary(range, now)
    expect(n.source).toBe('history')
    expect(n.messages).toBe(120)
    expect(f.messages).toBe(240)
    expect(f.positions.classA).toBe(240)
    expect(n.distance.p99M!).toBeLessThan(8 * 1852)
    expect(f.distance.p99M!).toBeGreaterThan(30 * 1852)
    // No per-source maximum gauge: history knows no maximum.
    expect(f.distance.maxM).toBeNull()
    // Only the source counters were read.
    const read = history.requests.flatMap((r) => r.pathSpecs.map((p) => p.path))
    expect(read.every((p) => p.includes('.sources.'))).toBe(true)
  })
})

describe('sourceStatistics option', () => {
  it('is off by default and read as a boolean', () => {
    expect(DEFAULT_CONFIG.sourceStatistics).toBe(false)
    expect(resolveConfig({}).sourceStatistics).toBe(false)
    expect(resolveConfig({ sourceStatistics: true }).sourceStatistics).toBe(
      true,
    )
    expect(resolveConfig({ sourceStatistics: 'yes' }).sourceStatistics).toBe(
      false,
    )
    const schema = configSchema.properties as Record<
      string,
      { type: string; description: string }
    >
    expect(schema.sourceStatistics!.type).toBe('boolean')
    expect(schema.sourceStatistics!.description).toMatch(/history load/)
  })
})

describe('plugin with per-source statistics', () => {
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
    vi.setSystemTime(Date.UTC(2030, 0, 1, 12, 0, 30))
  })
  afterEach(() => vi.useRealTimers())

  async function started(options: object) {
    const f = fakeApp(await mkdtemp(join(tmpdir(), 'ais-sources-')))
    const plugin = createPlugin(f.app as never)
    const r = fakeRouter()
    plugin.registerWithRouter!(r.router as never)
    await plugin.start(options, () => undefined)
    f.position(OWN.lat, OWN.lon)
    const p = destination(OWN, 90, 10)
    const q = destination(OWN, 180, 30)
    // Both receivers hear vessel 1; only NMEA 0183 hears vessel 2, twice.
    f.app.emit('nmea0183', classA(999000001, p.lat, p.lon))
    f.app.emit('N2KAnalyzerOut', classAPgn(999000001, p.lat, p.lon))
    f.app.emit('nmea0183', classA(999000002, q.lat, q.lon))
    f.app.emit('nmea0183', classA(999000002, q.lat, q.lon))
    f.app.emit('nmea0183', '!AIVDM,garbage')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const values = new Map(
      f.deltas[0]!.delta.updates[0]!.values.map((v) => [v.path, v.value]),
    )
    return { f, plugin, r, values }
  }

  it('counts each event apart while the main figures count everything', async () => {
    const { f, plugin, r, values } = await started({ sourceStatistics: true })
    expect(f.deltas[0]!.id).toBe(PLUGIN_ID)
    const a = sourcePaths('nmea0183')
    const b = sourcePaths('N2KAnalyzerOut')
    // The main figures are unchanged: vessel 1 counts twice.
    expect(values.get(paths.messagesTotal)).toBe(4)
    expect(values.get(a.messagesTotal)).toBe(3)
    expect(values.get(b.messagesTotal)).toBe(1)
    expect(values.get(a.positionsClassA)).toBe(3)
    // Duplicates count on the event that delivered the copy.
    expect(values.get(a.health('duplicates'))).toBe(1)
    expect(values.get(a.health('duplicatesCrossEvent'))).toBe(0)
    expect(values.get(b.health('duplicatesCrossEvent'))).toBe(1)
    expect(values.get(a.health('decodeErrors'))).toBe(1)
    expect(values.get(b.health('decodeErrors'))).toBe(0)
    expect(values.get(paths.healthDecodeErrors)).toBe(1)

    expect((await r.call('/sources')).body).toEqual({
      sources: [
        { label: 'nmea0183', event: 'nmea0183' },
        { label: 'N2KAnalyzerOut', event: 'N2KAnalyzerOut' },
      ],
    })
    const s = (await r.call('/summary', { window: '1h', source: 'nmea0183' }))
      .body as { messages: number; distance: { maxM: number } }
    expect(s.messages).toBe(3)
    expect(s.distance.maxM).toBeCloseTo(30 * 1852, -2)
    const all = (await r.call('/summary', { window: '1h', source: 'all' }))
      .body as { messages: number }
    expect(all.messages).toBe(4)
    expect(
      (await r.call('/summary', { window: '1h', source: 'nope' })).status,
    ).toBe(400)
    const status = (await r.call('/status')).body as {
      sources: { label: string; messages: number; health: object }[]
    }
    expect(status.sources).toMatchObject([
      { label: 'nmea0183', messages: 3, health: { duplicates: 1 } },
      {
        label: 'N2KAnalyzerOut',
        messages: 1,
        health: { duplicatesCrossEvent: 1 },
      },
    ])
    // The last delta on stop carries the source counters too.
    await plugin.stop()
    const last = f.deltas[f.deltas.length - 1]!.delta.updates[0]!.values
    expect(last.some((v) => v.path === b.messagesTotal)).toBe(true)
  })

  it('publishes no source paths and answers no source while off', async () => {
    const { plugin, r, values } = await started({})
    expect([...values.keys()].some((p) => p.includes('.sources.'))).toBe(false)
    expect(values.get(paths.messagesTotal)).toBe(4)
    expect((await r.call('/sources')).body).toEqual({ sources: [] })
    expect(
      (await r.call('/summary', { window: '1h', source: 'nmea0183' })).status,
    ).toBe(400)
    expect(
      ((await r.call('/status')).body as { sources: unknown[] }).sources,
    ).toEqual([])
    await plugin.stop()
  })
})
