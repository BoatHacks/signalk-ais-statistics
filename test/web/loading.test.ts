import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOADING_DELAY_MS, showLoading } from '../../web/src/loading'

function target() {
  const classes = new Set<string>()
  return {
    classes,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
    },
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('showLoading', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('marks a slow load after the delay and clears it when done', async () => {
    const t = target()
    const d = deferred()
    showLoading(t, d.promise)
    vi.advanceTimersByTime(LOADING_DELAY_MS - 1)
    expect(t.classes.has('loading')).toBe(false)
    vi.advanceTimersByTime(1)
    expect(t.classes.has('loading')).toBe(true)
    d.resolve()
    await vi.runAllTimersAsync()
    expect(t.classes.has('loading')).toBe(false)
  })

  it('never marks a quick load', async () => {
    const t = target()
    showLoading(t, Promise.resolve())
    await vi.runAllTimersAsync()
    expect(t.classes.has('loading')).toBe(false)
  })

  it('clears the mark when the load fails', async () => {
    const t = target()
    const d = deferred()
    showLoading(t, d.promise)
    vi.advanceTimersByTime(LOADING_DELAY_MS)
    d.reject(new Error('offline'))
    await d.promise.catch(() => undefined)
    await vi.runAllTimersAsync()
    expect(t.classes.has('loading')).toBe(false)
  })

  it('stops early when a later load takes over', () => {
    const t = target()
    const stop = showLoading(t, new Promise(() => {}))
    vi.advanceTimersByTime(LOADING_DELAY_MS)
    expect(t.classes.has('loading')).toBe(true)
    stop()
    expect(t.classes.has('loading')).toBe(false)
  })
})
