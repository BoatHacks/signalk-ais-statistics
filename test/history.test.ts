import { describe, expect, it } from 'vitest'
import {
  HistoryApiReader,
  connectHistory,
  increments,
  mergeSeries,
  nullHistoryReader,
  parseRows,
} from '../src/history'
import { FakeHistory } from './fixtures/history'

describe('increments', () => {
  it('differences a counter, treating leading nulls as zero', () => {
    expect(increments([null, null, 3, 5, 5, 9])).toEqual([0, 3, 2, 0, 4])
  })

  it('treats later nulls as unchanged', () => {
    expect(increments([2, null, 4])).toEqual([0, 2])
  })

  it('detects a counter reset and counts from zero', () => {
    expect(increments([100, 120, 7, 10])).toEqual([20, 7, 3])
  })

  it('counts the part before a restart inside a bucket from its max', () => {
    // 5 minute buckets: the counter reached 716 and restarted at 0 inside
    // the third bucket, ending it at 68.
    expect(increments([0, 320, 68, 477], [0, 320, 716, 477])).toEqual([
      320,
      396 + 68,
      409,
    ])
  })

  it('ignores max where it adds nothing', () => {
    expect(increments([0, 5, 9], [null, 5, 9])).toEqual([5, 4])
    expect(increments([100, 120, 7], [100, 120, null])).toEqual([20, 7])
  })

  it('is empty for one bucket', () => {
    expect(increments([5])).toEqual([])
  })
})

describe('parseRows and mergeSeries', () => {
  it('parses timestamps and non-numeric values as null', () => {
    const s = parseRows(
      [
        ['2030-01-01T00:00:00Z', 1, 'x'],
        ['bad', 2, 3],
      ],
      2,
    )
    expect(s.times).toEqual([Date.UTC(2030, 0, 1)])
    expect(s.values).toEqual([[1], [null]])
  })

  it('aligns chunks on time', () => {
    const m = mergeSeries([
      { times: [1, 2], values: [[10, 20]] },
      { times: [2, 3], values: [[200, 300]] },
    ])
    expect(m.times).toEqual([1, 2, 3])
    expect(m.values).toEqual([
      [10, 20, null],
      [null, 200, 300],
    ])
  })
})

describe('HistoryApiReader', () => {
  it('always passes a resolution and splits many paths into chunks', async () => {
    const fake = new FakeHistory()
    const t0 = Date.UTC(2030, 0, 1)
    fake.record([{ path: 'p.0', value: 1 }], t0 + 1000)
    const reader = new HistoryApiReader(fake)
    const paths = Array.from({ length: 90 }, (_, i) => `p.${i}`)
    const s = await reader.series(paths, 'last', t0, t0 + 3_600_000, 600)
    expect(fake.requests).toHaveLength(3)
    expect(fake.requests.every((r) => r.resolution === 600)).toBe(true)
    expect(s.values).toHaveLength(90)
    expect(s.times).toHaveLength(6)
    expect(s.values[0]).toEqual([1, 1, 1, 1, 1, 1])
    expect(s.values[1]![0]).toBeNull()
  })
})

describe('connectHistory', () => {
  it('falls back to live-only mode', async () => {
    expect(await connectHistory({})).toBe(nullHistoryReader)
    expect(
      await connectHistory({
        getHistoryApi: () => Promise.reject(new Error()),
      }),
    ).toBe(nullHistoryReader)
    const reader = await connectHistory({
      getHistoryApi: async () => new FakeHistory(),
    })
    expect(reader.available).toBe(true)
  })
})
