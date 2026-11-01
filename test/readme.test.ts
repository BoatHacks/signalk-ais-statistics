// The README's configuration table lists every option in the order of the
// server's config form, and its images exist, so it cannot drift from
// src/config.ts or from the screenshots.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONFIG_ORDER } from '../src/config'

const root = join(__dirname, '..')
const readme = readFileSync(join(root, 'README.md'), 'utf8')

describe('README.md', () => {
  it('lists every option in the order of the config form', () => {
    const rows = [...readme.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1])
    expect(rows).toEqual(CONFIG_ORDER)
  })

  it('shows only screenshots that exist', () => {
    const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(
      (m) => m[1]!,
    )
    expect(images.length).toBeGreaterThan(0)
    for (const image of images)
      expect(existsSync(join(root, image)), image).toBe(true)
  })
})
