import { afterEach, describe, expect, it, vi } from 'vitest'
import { layerVisible, saveLayerVisible } from '../../web/src/layers'

function fakeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  }
}

describe('map layer visibility', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the layers until one is switched off', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(layerVisible('cells')).toBe(true)
    expect(layerVisible('sectorsA')).toBe(true)
    expect(layerVisible('sectorsB')).toBe(true)
    saveLayerVisible('sectorsA', false)
    expect(layerVisible('sectorsA')).toBe(false)
    expect(layerVisible('sectorsB')).toBe(true)
    expect(layerVisible('cells')).toBe(true)
    saveLayerVisible('sectorsA', true)
    expect(layerVisible('sectorsA')).toBe(true)
  })

  it('carries a saved radar choice over to both sector layers', () => {
    const storage = fakeStorage()
    storage.setItem('signalk-ais-statistics.layer.radar', 'off')
    vi.stubGlobal('localStorage', storage)
    expect(layerVisible('sectorsA')).toBe(false)
    expect(layerVisible('sectorsB')).toBe(false)
    saveLayerVisible('sectorsB', true)
    expect(layerVisible('sectorsB')).toBe(true)
    expect(layerVisible('sectorsA')).toBe(false)
  })

  it('hides the cells beyond the cap until switched on', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(layerVisible('capped')).toBe(false)
    saveLayerVisible('capped', true)
    expect(layerVisible('capped')).toBe(true)
  })

  it('shows both layers when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(layerVisible('cells')).toBe(true)
    expect(layerVisible('capped')).toBe(false)
    expect(() => saveLayerVisible('cells', false)).not.toThrow()
  })
})
