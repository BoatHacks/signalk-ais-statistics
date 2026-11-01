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

  it('shows both layers until one is switched off', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(layerVisible('cells')).toBe(true)
    expect(layerVisible('radar')).toBe(true)
    saveLayerVisible('radar', false)
    expect(layerVisible('radar')).toBe(false)
    expect(layerVisible('cells')).toBe(true)
    saveLayerVisible('radar', true)
    expect(layerVisible('radar')).toBe(true)
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
