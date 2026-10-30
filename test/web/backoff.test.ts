import { describe, expect, it } from 'vitest'
import { backoffDelay } from '../../web/src/backoff'

describe('backoffDelay', () => {
  it('doubles from 1 s up to 60 s', () => {
    const mid = () => 0.5
    expect(backoffDelay(0, mid)).toBe(1000)
    expect(backoffDelay(1, mid)).toBe(2000)
    expect(backoffDelay(5, mid)).toBe(32000)
    expect(backoffDelay(6, mid)).toBe(60000)
    expect(backoffDelay(50, mid)).toBe(60000)
  })

  it('adds up to 20 percent jitter either way', () => {
    expect(backoffDelay(3, () => 0)).toBe(6400)
    expect(backoffDelay(3, () => 1)).toBe(9600)
  })
})
