import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getHexagonAreaAvg, latLngToCell } from 'h3-js'
import { describe, expect, it } from 'vitest'
import { DAY_MS } from '../src/aggregate'
import {
  Coverage,
  MAX_CELLS_PER_DAY,
  footprintGeoJson,
  utcDay,
} from '../src/coverage'
import { destination } from '../src/geo'
import { OWN } from './fixtures/ais'

const T0 = Date.UTC(2030, 0, 10, 12)

async function dir() {
  return mkdtemp(join(tmpdir(), 'ais-coverage-'))
}

function addAt(c: Coverage, bearing: number, nm: number, time = T0) {
  const p = destination(OWN, bearing, nm)
  c.add(p.lat, p.lon, nm, time)
}

describe('Coverage', () => {
  it('collects cells and area for today', async () => {
    const c = new Coverage(await dir(), 5, 90, 100, T0)
    addAt(c, 0, 5)
    addAt(c, 0, 5)
    addAt(c, 90, 20)
    const t = c.today(T0)
    expect(t.cells).toBe(2)
    expect(t.areaKm2).toBeCloseTo(2 * getHexagonAreaAvg(5, 'km2'), 6)
  })

  it('caps cells beyond the distance percentile but keeps their reports', async () => {
    const c = new Coverage(await dir(), 5, 90, 99, T0)
    for (let i = 0; i < 500; i++) addAt(c, (i * 7) % 360, 10)
    addAt(c, 45, 2500)
    const f = await c.footprint(1, T0)
    expect(f.cappedCells).toBe(1)
    expect(f.capNm).toBeLessThan(15)
    expect(f.cells.every((x) => x.minDistanceNm < 15)).toBe(true)
    const all = await c.footprint(1, T0)
    expect(all.capped).toHaveLength(1)
    expect(all.capped[0]!.reports).toBe(1)
    const uncapped = new Coverage(await dir(), 5, 90, 100, T0)
    addAt(uncapped, 45, 2500)
    expect((await uncapped.footprint(1, T0)).cells).toHaveLength(1)
  })

  it('keeps a far cell beyond the cap when it has 3 reports', async () => {
    const c = new Coverage(await dir(), 5, 90, 99, T0)
    for (let i = 0; i < 500; i++) addAt(c, (i * 7) % 360, 10)
    addAt(c, 45, 60)
    addAt(c, 45, 60)
    let f = await c.footprint(1, T0)
    expect(f.cappedCells).toBe(1)
    addAt(c, 45, 60)
    f = await c.footprint(1, T0)
    expect(f.cappedCells).toBe(0)
    expect(f.cells.some((x) => x.minDistanceNm > 50)).toBe(true)
    expect(c.today(T0).cells).toBe(f.cells.length)
  })

  it('disables the cap at 100 percent', async () => {
    const c = new Coverage(await dir(), 5, 90, 100, T0)
    for (let i = 0; i < 500; i++) addAt(c, (i * 7) % 360, 10)
    addAt(c, 45, 2500)
    const f = await c.footprint(1, T0)
    expect(f.capNm).toBeNull()
    expect(f.cappedCells).toBe(0)
    expect(f.cells.some((x) => x.minDistanceNm > 2000)).toBe(true)
  })

  it('applies a changed percentile, and a trial one for one answer only', async () => {
    const c = new Coverage(await dir(), 5, 90, 99, T0)
    for (let i = 0; i < 500; i++) addAt(c, (i * 7) % 360, 10)
    addAt(c, 45, 2500)
    expect((await c.footprint(1, T0, 100)).cappedCells).toBe(0)
    expect((await c.footprint(1, T0)).cappedCells).toBe(1)
    c.setPercentile(100)
    expect((await c.footprint(1, T0)).cappedCells).toBe(0)
    expect(c.today(T0).cells).toBe((await c.footprint(1, T0)).cells.length)
  })

  it('takes the cap of a window from the merged days', async () => {
    const d = await dir()
    const c = new Coverage(d, 5, 90, 99, T0 - DAY_MS)
    // Yesterday: many far reports, so 60 nm is inside the 7 day cap.
    for (let i = 0; i < 300; i++) addAt(c, (i * 7) % 360, 70, T0 - DAY_MS)
    await c.flush()
    // Today: short range only, plus one report at 60 nm.
    for (let i = 0; i < 300; i++) addAt(c, (i * 7) % 360, 10, T0)
    addAt(c, 200, 60, T0)
    const today = await c.footprint(1, T0)
    expect(today.capped.map((x) => x.minDistanceNm)).toEqual([60])
    const week = await c.footprint(7, T0)
    expect(week.capNm).toBeGreaterThan(60)
    expect(week.cappedCells).toBe(0)
  })

  it('writes one file per day and reads it back after a restart', async () => {
    const d = await dir()
    const c = new Coverage(d, 5, 90, 100, T0)
    addAt(c, 0, 5)
    await c.flush()
    const files = await readdir(d)
    expect(files).toEqual([`coverage-${utcDay(T0)}.json`])
    const text = await readFile(join(d, files[0]!), 'utf8')
    expect(text.length).toBeLessThan(1000)

    const again = new Coverage(d, 5, 90, 100, T0 + 1000)
    await again.load(T0 + 1000)
    addAt(again, 180, 8, T0 + 1000)
    expect(again.today(T0 + 1000).cells).toBe(2)
  })

  it('keeps reports that arrive while the day file is loading', async () => {
    const d = await dir()
    const first = new Coverage(d, 5, 90, 100, T0)
    addAt(first, 0, 5)
    await first.flush()
    const c = new Coverage(d, 5, 90, 100, T0)
    const loading = c.load(T0)
    addAt(c, 180, 8)
    await loading
    expect(c.today(T0).cells).toBe(2)
  })

  it('unions days for a window and starts a new day at UTC midnight', async () => {
    const d = await dir()
    const c = new Coverage(d, 5, 90, 100, T0)
    addAt(c, 0, 5, T0)
    addAt(c, 180, 5, T0 + DAY_MS)
    await new Promise((r) => setTimeout(r, 20))
    expect(c.today(T0 + DAY_MS).cells).toBe(1)
    const f = await c.footprint(7, T0 + DAY_MS)
    expect(f.days).toHaveLength(7)
    expect(f.cells).toHaveLength(2)
    expect((await c.footprint(1, T0 + DAY_MS)).cells).toHaveLength(1)
  })

  it('prunes files past the retention period', async () => {
    const d = await dir()
    const old = new Coverage(d, 5, 3, 100, T0 - 5 * DAY_MS)
    addAt(old, 0, 5, T0 - 5 * DAY_MS)
    await old.flush()
    await writeFile(join(d, 'unrelated.txt'), 'x')
    const c = new Coverage(d, 5, 3, 100, T0)
    expect(await c.prune(T0)).toEqual([utcDay(T0 - 5 * DAY_MS)])
    expect(await readdir(d)).toEqual(['unrelated.txt'])
  })

  it('ignores corrupt files and converts cells of another resolution', async () => {
    const d = await dir()
    await writeFile(join(d, `coverage-${utcDay(T0 - DAY_MS)}.json`), '{oops')
    const fine = latLngToCell(0.01, 0.01, 7)
    await writeFile(
      join(d, `coverage-${utcDay(T0 - 2 * DAY_MS)}.json`),
      JSON.stringify({
        version: 1,
        date: utcDay(T0 - 2 * DAY_MS),
        resolution: 7,
        cells: { [fine]: [1, 3], nonsense: [1, 1] },
        distanceBins: new Array(32).fill(0),
      }),
    )
    const c = new Coverage(d, 5, 90, 100, T0)
    const f = await c.footprint(7, T0)
    expect(f.cells).toEqual([
      { id: latLngToCell(0.01, 0.01, 5), minDistanceNm: 1, reports: 3 },
    ])
  })

  it('produces closed GeoJSON polygons with an intensity', async () => {
    const c = new Coverage(await dir(), 5, 90, 100, T0)
    addAt(c, 0, 5)
    addAt(c, 0, 5)
    addAt(c, 90, 30)
    const g = footprintGeoJson(await c.footprint(1, T0))
    expect(g.features).toHaveLength(2)
    for (const f of g.features) {
      const ring = f.geometry.coordinates[0]!
      expect(ring[0]).toEqual(ring[ring.length - 1])
      expect(f.properties.intensity).toBeGreaterThan(0)
      expect(f.properties.intensity).toBeLessThanOrEqual(1)
    }
  })
})

describe('Coverage per own vessel mode', () => {
  const modeAt = (
    c: Coverage,
    mode: 'stationary' | 'underway' | 'unknown',
    bearing: number,
    nm: number,
    time = T0,
  ) => {
    const p = destination(OWN, bearing, nm)
    c.add(p.lat, p.lon, nm, time, mode)
  }

  it('keeps cells per mode and unions them for all', async () => {
    const c = new Coverage(await dir(), 5, 90, 100, T0)
    modeAt(c, 'stationary', 0, 5)
    modeAt(c, 'stationary', 0, 5)
    modeAt(c, 'underway', 0, 5)
    modeAt(c, 'underway', 90, 20)
    modeAt(c, 'unknown', 180, 20)
    const all = await c.footprint(1, T0)
    const st = await c.footprint(1, T0, 100, 'stationary')
    const uw = await c.footprint(1, T0, 100, 'underway')
    expect(all.mode).toBe('all')
    expect(st.mode).toBe('stationary')
    expect(all.cells).toHaveLength(3)
    expect(st.cells).toHaveLength(1)
    expect(uw.cells).toHaveLength(2)
    // A cell seen in two modes is one cell of the combined footprint.
    const shared = all.cells.find((x) => x.id === st.cells[0]!.id)!
    expect(shared.reports).toBe(3)
    expect(c.today(T0).cells).toBe(3)
  })

  it('caps every mode with the distances of all modes, so modes are subsets', async () => {
    const c = new Coverage(await dir(), 5, 90, 99, T0)
    for (let i = 0; i < 500; i++) modeAt(c, 'underway', (i * 7) % 360, 10)
    // Far and sparse while stationary: beyond the combined cap.
    modeAt(c, 'stationary', 45, 300)
    modeAt(c, 'stationary', 0, 2)
    const all = await c.footprint(1, T0)
    const st = await c.footprint(1, T0, 99, 'stationary')
    expect(st.capNm).toBe(all.capNm)
    expect(st.cappedCells).toBe(1)
    const ids = new Set(all.cells.map((x) => x.id))
    for (const mode of ['stationary', 'underway'] as const)
      for (const cell of (await c.footprint(1, T0, 99, mode)).cells)
        expect(ids.has(cell.id)).toBe(true)
  })

  it('writes version 2 files and reads the modes back after a restart', async () => {
    const d = await dir()
    const c = new Coverage(d, 5, 90, 100, T0)
    modeAt(c, 'stationary', 0, 5)
    modeAt(c, 'underway', 90, 20)
    await c.flush()
    const file = JSON.parse(
      await readFile(join(d, `coverage-${utcDay(T0)}.json`), 'utf8'),
    )
    expect(file.version).toBe(2)
    expect(Object.keys(file.modes).sort()).toEqual([
      'stationary',
      'underway',
      'unknown',
    ])
    expect(file.cells).toBeUndefined()

    const again = new Coverage(d, 5, 90, 100, T0 + 1000)
    await again.load(T0 + 1000)
    modeAt(again, 'stationary', 180, 8, T0 + 1000)
    const st = await again.footprint(1, T0 + 1000, 100, 'stationary')
    expect(st.cells).toHaveLength(2)
    expect(
      (await again.footprint(1, T0 + 1000, 100, 'underway')).cells,
    ).toHaveLength(1)
  })

  it('reads a version 1 file with its cells under unknown', async () => {
    const d = await dir()
    const id = latLngToCell(0.01, 0.01, 5)
    await writeFile(
      join(d, `coverage-${utcDay(T0 - DAY_MS)}.json`),
      JSON.stringify({
        version: 1,
        date: utcDay(T0 - DAY_MS),
        resolution: 5,
        cells: { [id]: [1, 3] },
        distanceBins: new Array(32).fill(0),
      }),
    )
    const c = new Coverage(d, 5, 90, 100, T0)
    expect((await c.footprint(7, T0)).cells).toEqual([
      { id, minDistanceNm: 1, reports: 3 },
    ])
    expect((await c.footprint(7, T0, 100, 'stationary')).cells).toEqual([])
    expect((await c.footprint(7, T0, 100, 'underway')).cells).toEqual([])
  })

  it('upgrades a version 1 file of today at the next flush', async () => {
    const d = await dir()
    const id = latLngToCell(0.01, 0.01, 5)
    const name = join(d, `coverage-${utcDay(T0)}.json`)
    await writeFile(
      name,
      JSON.stringify({
        version: 1,
        date: utcDay(T0),
        resolution: 5,
        cells: { [id]: [1, 3] },
        distanceBins: new Array(32).fill(0),
      }),
    )
    const c = new Coverage(d, 5, 90, 100, T0)
    await c.load(T0)
    await c.flush()
    const file = JSON.parse(await readFile(name, 'utf8'))
    expect(file.version).toBe(2)
    expect(file.modes.unknown).toEqual({ [id]: [1, 3] })
  })

  it('skips mode entries that are not cell maps, and unknown versions', async () => {
    const d = await dir()
    const id = latLngToCell(0.01, 0.01, 5)
    const write = (days: number, body: object) =>
      writeFile(
        join(d, `coverage-${utcDay(T0 - days * DAY_MS)}.json`),
        JSON.stringify({
          date: utcDay(T0 - days * DAY_MS),
          resolution: 5,
          distanceBins: new Array(32).fill(0),
          ...body,
        }),
      )
    await write(1, {
      version: 2,
      modes: { stationary: [1, 2], underway: { [id]: [2, 4] }, unknown: 'x' },
    })
    await write(2, { version: 2, modes: 'nope' })
    await write(3, { version: 3, modes: { underway: { [id]: [9, 9] } } })
    const c = new Coverage(d, 5, 90, 100, T0)
    expect((await c.footprint(7, T0)).cells).toEqual([
      { id, minDistanceNm: 2, reports: 4 },
    ])
  })

  it('counts the cell limit over mode and cell pairs', async () => {
    const c = new Coverage(await dir(), 8, 90, 100, T0)
    // A grid of distinct cells, each about 1 km apart.
    const at = (i: number) => ({
      lat: (i % 150) * 0.01,
      lon: Math.floor(i / 150) * 0.01,
    })
    for (let i = 0; i < MAX_CELLS_PER_DAY / 2; i++) {
      const p = at(i)
      c.add(p.lat, p.lon, 1, T0, 'stationary')
      c.add(p.lat, p.lon, 1, T0, 'underway')
    }
    expect(c.droppedCells).toBe(0)
    const p = at(MAX_CELLS_PER_DAY)
    c.add(p.lat, p.lon, 1, T0, 'unknown')
    expect(c.droppedCells).toBe(1)
    // Known cells still count.
    c.add(at(0).lat, at(0).lon, 1, T0, 'stationary')
    expect(c.droppedCells).toBe(1)
  })
})
