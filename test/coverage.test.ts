import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getHexagonAreaAvg, latLngToCell } from 'h3-js'
import { describe, expect, it } from 'vitest'
import { DAY_MS } from '../src/aggregate'
import { Coverage, footprintGeoJson, utcDay } from '../src/coverage'
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
