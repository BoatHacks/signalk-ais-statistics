import { getEnumeration } from '@canboat/ts-pgns'
import { describe, expect, it } from 'vitest'
import { LOOKUPS, type LookupName } from '../src/n2k-lookups'

// The local tables are a copy of canboat's, so the plugin need not ship
// @canboat/ts-pgns. This keeps the copy from drifting when canboat changes.
describe('canboat lookup copies', () => {
  for (const name of Object.keys(LOOKUPS) as LookupName[])
    it(`${name} matches @canboat/ts-pgns`, () => {
      const upstream = Object.fromEntries(
        getEnumeration(name)!.EnumValues.map((v) => [v.Name, v.Value]),
      )
      expect(LOOKUPS[name]).toEqual(upstream)
    })
})
