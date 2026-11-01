import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Aggregator, DAY_MS, HOUR_MS, type Located } from '../src/aggregate'
import { destination } from '../src/geo'
import type { SpeedSample } from '../src/health'
import {
  LongRangeLog,
  MAX_FASTEST_PER_DAY,
  MAX_PER_DAY,
} from '../src/longrange'
import { OWN } from './fixtures/ais'

const T0 = Date.UTC(2030, 0, 1, 12)
const NM = 1852

function located(mmsi: string, nm: number, time = T0, bearing = 50): Located {
  const agg = new Aggregator(time)
  const p = destination(OWN, bearing, nm)
  return agg.add({ type: 1, mmsi, ...p }, OWN, time)!
}

const dir = () => mkdtemp(join(tmpdir(), 'ais-longrange-'))

describe('LongRangeLog', () => {
  it('keeps the farthest reception of each vessel with both positions', async () => {
    const log = new LongRangeLog(await dir(), 14, T0)
    log.add(located('999000001', 10), {})
    log.add(located('999000001', 30, T0 + 1000), { name: 'SYNTHETIC' })
    log.add(located('999000001', 20, T0 + 2000), {})
    log.add(located('999000002', 15), { shipType: 70 })
    const e = await log.entries(T0, T0 + HOUR_MS, 10)
    expect(e.map((x) => x.mmsi)).toEqual(['999000001', '999000002'])
    expect(e[0]).toMatchObject({
      time: new Date(T0 + 1000).toISOString(),
      name: 'SYNTHETIC',
      cls: 'A',
      ownLat: 0,
      ownLon: 0,
    })
    expect(e[0]!.distanceM).toBeCloseTo(30 * NM, -1)
    expect(e[0]!.bearingDeg).toBeCloseTo(50, 0)
    expect(e[1]!.shipType).toBe(70)
  })

  it('keeps only the farthest vessels of a day', async () => {
    const log = new LongRangeLog(await dir(), 14, T0)
    for (let i = 0; i < MAX_PER_DAY + 10; i++)
      log.add(located(`9990${String(i).padStart(5, '0')}`, 1 + i), {})
    const e = await log.entries(T0, T0 + 1, 1000)
    expect(e).toHaveLength(MAX_PER_DAY)
    expect(Math.min(...e.map((x) => x.distanceM))).toBeGreaterThan(10 * NM)
  })

  it('replaces a vessel by its own farther report when the day is full', async () => {
    const log = new LongRangeLog(await dir(), 14, T0)
    for (let i = 0; i < MAX_PER_DAY; i++)
      log.add(located(`9990${String(i).padStart(5, '0')}`, 10 + i), {})
    // The nearest vessel is received farther: it moves up, nobody leaves.
    log.add(located('999000000', 200, T0 + 1000), {})
    // A nearer report of a kept vessel changes nothing.
    log.add(located('999000001', 1, T0 + 2000), {})
    const e = await log.entries(T0, T0 + HOUR_MS, 1000)
    expect(e).toHaveLength(MAX_PER_DAY)
    expect(e[0]).toMatchObject({ mmsi: '999000000' })
    expect(e[0]!.distanceM).toBeCloseTo(200 * NM, -2)
    expect(e.find((x) => x.mmsi === '999000001')!.distanceM).toBeCloseTo(
      11 * NM,
      -1,
    )
  })

  it('does not let a nearer new vessel into a full day', async () => {
    const log = new LongRangeLog(await dir(), 14, T0)
    for (let i = 0; i < MAX_PER_DAY; i++)
      log.add(located(`9990${String(i).padStart(5, '0')}`, 10 + i), {})
    log.add(located('999100000', 5), {})
    const e = await log.entries(T0, T0 + 1, 1000)
    expect(e.some((x) => x.mmsi === '999100000')).toBe(false)
  })

  it('fills in a name learnt later', async () => {
    const log = new LongRangeLog(await dir(), 14, T0)
    log.add(located('999000003', 12), {})
    log.enrich(() => ({ name: 'LATER' }))
    expect((await log.entries(T0, T0 + 1, 5))[0]!.name).toBe('LATER')
  })

  it('writes, reads back across a restart and prunes day files', async () => {
    const d = await dir()
    const first = new LongRangeLog(d, 2, T0)
    first.add(located('999000004', 40, T0 - DAY_MS), {})
    first.add(located('999000005', 25), {})
    await first.flush()
    await writeFile(join(d, 'longrange-2029-12-01.json'), '{"entries":[]}')
    const again = new LongRangeLog(d, 2, T0)
    await again.load(T0)
    const e = await again.entries(T0 - 2 * DAY_MS, T0 + 1, 10)
    expect(e.map((x) => x.mmsi)).toEqual(['999000004', '999000005'])
    expect(await again.prune(T0)).toEqual(['2029-12-01'])
    expect((await readdir(d)).sort()).toEqual([
      'longrange-2029-12-31.json',
      'longrange-2030-01-01.json',
    ])
  })

  it('ignores damaged files', async () => {
    const d = await dir()
    await writeFile(join(d, 'longrange-2030-01-01.json'), 'not json')
    const log = new LongRangeLog(d, 14, T0)
    await log.load(T0)
    expect(await log.entries(T0 - DAY_MS, T0 + 1, 10)).toEqual([])
  })
})

function speed(
  mmsi: string,
  mps: number,
  time = T0,
  extra: Partial<SpeedSample> = {},
): SpeedSample {
  return {
    mmsi,
    messageType: 1,
    time,
    speedMps: mps,
    limitMps: 30.87,
    implausible: mps > 30.87,
    gapS: 30,
    fromLat: 0.1,
    fromLon: 0.1,
    lat: 0.11,
    lon: 0.1,
    ...extra,
  }
}

describe('LongRangeLog fastest list', () => {
  it('keeps the highest speed of each sender, fastest first', async () => {
    const log = new LongRangeLog(await dir(), 14, T0)
    log.addSpeed(speed('999000001', 10), {})
    log.addSpeed(speed('999000001', 20, T0 + 1000, { sogMps: 19.5 }), {
      name: 'SYNTHETIC',
      shipType: 40,
    })
    log.addSpeed(speed('999000001', 15, T0 + 2000), {})
    log.addSpeed(speed('999000002', 300, T0 + 3000), {})
    const f = await log.fastest(T0, T0 + HOUR_MS, 10)
    expect(f.map((x) => x.mmsi)).toEqual(['999000001'])
    const jumps = await log.fastest(T0, T0 + HOUR_MS, 10, true)
    expect(jumps.map((x) => x.mmsi)).toEqual(['999000002'])
    expect(jumps[0]!.implausible).toBe(true)
    expect(f[0]).toMatchObject({
      time: new Date(T0 + 1000).toISOString(),
      speedMps: 20,
      sogMps: 19.5,
      name: 'SYNTHETIC',
      shipType: 40,
      cls: 'A',
      gapS: 30,
    })
  })

  it('keeps plausible speeds and implausible jumps in separate lists', async () => {
    const log = new LongRangeLog(await dir(), 14, T0)
    // A day full of bogus jumps does not push out a real fast craft.
    for (let i = 0; i < MAX_FASTEST_PER_DAY + 5; i++)
      log.addSpeed(speed(`9991${String(i).padStart(5, '0')}`, 100 + i), {})
    log.addSpeed(speed('999000009', 25), {})
    // One sender can be in both: its fastest real speed and its worst jump.
    log.addSpeed(speed('999000009', 500), {})
    const f = await log.fastest(T0, T0 + 1, 100)
    expect(f.map((x) => [x.mmsi, x.speedMps])).toEqual([['999000009', 25]])
    const jumps = await log.fastest(T0, T0 + 1, 100, true)
    expect(jumps).toHaveLength(MAX_FASTEST_PER_DAY)
    expect(jumps[0]).toMatchObject({ mmsi: '999000009', speedMps: 500 })
  })

  it('keeps only the fastest senders of a day', async () => {
    const log = new LongRangeLog(await dir(), 14, T0)
    for (let i = 0; i < MAX_FASTEST_PER_DAY + 5; i++)
      log.addSpeed(speed(`9990${String(i).padStart(5, '0')}`, 1 + i), {})
    const f = await log.fastest(T0, T0 + 1, 1000)
    expect(f).toHaveLength(MAX_FASTEST_PER_DAY)
    expect(Math.min(...f.map((x) => x.speedMps))).toBe(6)
  })

  it('fills in a name learnt later', async () => {
    const log = new LongRangeLog(await dir(), 14, T0)
    log.addSpeed(speed('999000003', 12), {})
    log.enrich(() => ({ name: 'LATER' }))
    expect((await log.fastest(T0, T0 + 1, 5))[0]!.name).toBe('LATER')
  })

  it('writes version 2 files and reads them back with both lists', async () => {
    const d = await dir()
    const first = new LongRangeLog(d, 14, T0)
    first.add(located('999000004', 40), {})
    first.addSpeed(speed('999000004', 12), {})
    await first.flush()
    const file = JSON.parse(
      await readFile(join(d, 'longrange-2030-01-01.json'), 'utf8'),
    )
    expect(file.version).toBe(2)
    expect(file.entries).toHaveLength(1)
    expect(file.fastest).toHaveLength(1)
    const again = new LongRangeLog(d, 14, T0)
    await again.load(T0)
    expect((await again.fastest(T0, T0 + 1, 5))[0]!.speedMps).toBe(12)
    expect(await again.entries(T0, T0 + 1, 5)).toHaveLength(1)
  })

  it('reads version 1 files and skips malformed entries', async () => {
    const d = await dir()
    const v1 = {
      version: 1,
      date: '2029-12-31',
      entries: [
        {
          time: new Date(T0 - DAY_MS).toISOString(),
          mmsi: '999000005',
          cls: 'A',
          distanceM: 50_000,
          bearingDeg: 90,
          lat: 0,
          lon: 0.5,
          ownLat: 0,
          ownLon: 0,
        },
      ],
    }
    await writeFile(join(d, 'longrange-2029-12-31.json'), JSON.stringify(v1))
    const bad = { ...v1, date: '2030-01-01', entries: [], fastest: 'nope' }
    await writeFile(join(d, 'longrange-2030-01-01.json'), JSON.stringify(bad))
    const log = new LongRangeLog(d, 14, T0)
    await log.load(T0)
    expect(await log.entries(T0 - DAY_MS, T0 + 1, 5)).toHaveLength(1)
    expect(await log.fastest(T0 - DAY_MS, T0 + 1, 5)).toEqual([])
    const mixed = {
      ...v1,
      fastest: [{ mmsi: '999000006' }, speedEntry('999000007')],
    }
    await writeFile(join(d, 'longrange-2029-12-31.json'), JSON.stringify(mixed))
    const again = new LongRangeLog(d, 14, T0)
    expect(
      (await again.fastest(T0 - DAY_MS, T0, 5)).map((x) => x.mmsi),
    ).toEqual(['999000007'])
  })

  it('starts a new list when the day changes', async () => {
    const log = new LongRangeLog(await dir(), 14, T0)
    log.addSpeed(speed('999000008', 12), {})
    log.addSpeed(speed('999000008', 5, T0 + DAY_MS), {})
    const f = await log.fastest(T0 + DAY_MS, T0 + DAY_MS + 1, 5)
    expect(f.map((x) => x.speedMps)).toEqual([5])
    expect(
      (await log.fastest(T0, T0 + DAY_MS + 1, 5)).map((x) => x.speedMps),
    ).toEqual([12])
  })
})

function speedEntry(mmsi: string) {
  return {
    time: new Date(T0 - DAY_MS).toISOString(),
    mmsi,
    cls: 'A',
    speedMps: 10,
    limitMps: 30.87,
    implausible: false,
    gapS: 30,
    fromLat: 0,
    fromLon: 0,
    lat: 0.01,
    lon: 0,
  }
}
