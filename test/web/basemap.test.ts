import { describe, expect, it } from 'vitest'
import { chooseBasemap } from '../../web/src/basemap'

describe('chooseBasemap', () => {
  it('uses OpenStreetMap whenever the server has no charts', () => {
    expect(chooseBasemap('charts', 'offline', false, false)).toBe('osm')
    expect(chooseBasemap(undefined, 'metered', true, false)).toBe('osm')
  })

  it('otherwise follows a saved choice, then the connection', () => {
    expect(chooseBasemap('charts', 'online', true, true)).toBe('charts')
    expect(chooseBasemap(undefined, 'metered', true, true)).toBe('charts')
    expect(chooseBasemap(undefined, 'online', true, true)).toBe('osm')
    expect(chooseBasemap(undefined, undefined, false, true)).toBe('charts')
  })
})
