import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Aggregator, DAY_MS, HOUR_MS, type Located } from '../src/aggregate'
import { destination } from '../src/geo'
import { LongRangeLog, MAX_PER_DAY } from '../src/longrange'
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
