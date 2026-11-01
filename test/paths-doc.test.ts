// docs/paths.md is checked against src/paths.ts, so the page lists exactly
// the paths the plugin publishes, with their units, kinds and cadence.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Aggregator } from '../src/aggregate'
import { destination } from '../src/geo'
import {
  DISTANCE_BIN_COUNT,
  PATH_PREFIX,
  SECTOR_CLASSES,
  SECTOR_COUNT,
  TYPE_GROUPS,
  paths,
} from '../src/paths'
import { buildValues, defaultMetadata } from '../src/publish'
import { OWN } from './fixtures/ais'

interface Row {
  unit: string
  kind: string
  cadence: string
}

const root = join(__dirname, '..')

function documented(): Map<string, Row> {
  const text = readFileSync(join(root, 'docs/paths.md'), 'utf8')
  const rows = new Map<string, Row>()
  for (const line of text.split('\n')) {
    const m = /^\| `([^`]+)` \|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line)
    if (m)
      rows.set(m[1]!, {
        unit: m[2]!.trim(),
        kind: m[3]!.trim(),
        cadence: m[4]!.trim(),
      })
  }
  return rows
}

/** The documented pattern of a concrete path, without the prefix. */
function pattern(path: string): string {
  return path
    .slice(PATH_PREFIX.length + 1)
    .replace(/^distance\.bin\.\d{2}$/, 'distance.bin.<nn>')
    .replace(/^sectors\.\d{3}\.[ab]\./, 'sectors.<nnn>.<class>.')
    .replace(
      new RegExp(`^vessels\\.byGroup\\.(${TYPE_GROUPS.join('|')})\\.`),
      'vessels.byGroup.<group>.',
    )
}

/** Every concrete path from `paths`, with the key it came from. */
function allPaths(): { key: string; path: string }[] {
  const out: { key: string; path: string }[] = []
  for (const [key, v] of Object.entries(paths)) {
    if (typeof v === 'string') out.push({ key, path: v })
    else if (key === 'distanceBin')
      for (let i = 0; i < DISTANCE_BIN_COUNT; i++)
        out.push({ key, path: paths.distanceBin(i) })
    else if (key.startsWith('sector'))
      for (const cls of SECTOR_CLASSES)
        for (let s = 0; s < SECTOR_COUNT; s++)
          out.push({
            key,
            path: (v as (s: number, c: string) => string)(s, cls),
          })
    else if (key.startsWith('vesselsByGroup'))
      for (const g of TYPE_GROUPS)
        out.push({ key, path: (v as (g: string) => string)(g) })
    else throw new Error(`no expansion for paths.${key}; extend this test`)
  }
  return out
}

/** Keys listed under the "Counters" comment in src/paths.ts. */
function counterKeys(): Set<string> {
  const src = readFileSync(join(root, 'src/paths.ts'), 'utf8')
  const block = /\/\/ Counters[^\n]*\n([\s\S]*?)\n\s*\/\/ Gauges/.exec(src)
  if (!block) throw new Error('Counters and Gauges comments not found')
  return new Set([...block[1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!))
}

describe('docs/paths.md', () => {
  const docs = documented()
  const all = allPaths()

  it('lists every published path pattern and nothing else', () => {
    const fromCode = new Set(all.map((p) => pattern(p.path)))
    expect([...docs.keys()].sort()).toEqual([...fromCode].sort())
  })

  it('gives the unit of the default metadata', () => {
    const units = new Map(defaultMetadata().map((m) => [m.path, m.meta.units]))
    for (const { path } of all)
      expect(docs.get(pattern(path))!.unit, path).toBe(units.get(path) ?? '')
  })

  it('marks counters and gauges as src/paths.ts groups them', () => {
    const counters = counterKeys()
    for (const { key, path } of all)
      expect(docs.get(pattern(path))!.kind, path).toBe(
        counters.has(key) ? 'counter' : 'gauge',
      )
  })

  it('marks as hourly exactly the paths left out between hours', () => {
    // A minute of reports in every sector, so every gauge has a value.
    const t = Date.UTC(2030, 0, 1, 12)
    const agg = new Aggregator(t)
    for (let s = 0; s < SECTOR_COUNT; s++)
      for (const type of [1, 18]) {
        const p = destination(OWN, s * 15 + 5, 10 + s)
        agg.add({ type, mmsi: String(999000100 + s * 2 + type), ...p }, OWN, t)
      }
    const coverage = { cells: 3, areaKm2: 100 }
    const full = buildValues(agg, t + 1000, coverage).map((v) => v.path)
    const between = new Set(
      buildValues(agg, t + 1000, coverage, { sectors: false }).map(
        (v) => v.path,
      ),
    )
    expect(new Set(full)).toEqual(new Set(all.map((p) => p.path)))
    for (const path of full)
      expect(docs.get(pattern(path))!.cadence, path).toBe(
        between.has(path) ? 'interval' : 'hourly',
      )
  })
})
