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
import { seeded } from './fixtures/random'

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

  it('counts a restart that does not drop below the previous bucket', () => {
    // The counter reached 1 and restarted at 0 inside the second bucket.
    expect(increments([0, 0], [0, 1])).toEqual([1])
    // 10 to 12, restart, then up to 11 inside the second bucket.
    expect(increments([10, 11], [10, 12])).toEqual([2 + 11])
  })

  it('ignores max where it adds nothing', () => {
    expect(increments([0, 5, 9], [null, 5, 9])).toEqual([5, 4])
    expect(increments([100, 120, 7], [100, 120, null])).toEqual([20, 7])
  })

  it('counts several restarts in one window', () => {
    // Up to 50, restart, up to 30, restart inside a bucket (max 45, ends at
    // 4), then on to 10.
    expect(increments([0, 50, 12, 30, 4, 10], [0, 50, 12, 30, 45, 10])).toEqual(
      [50, 12, 18, 15 + 4, 6],
    )
  })

  it('counts a restart inside the first bucket from the first value', () => {
    // The window starts after the restart: nothing before it is known, so
    // the first bucket is the baseline whatever its max was.
    expect(increments([3, 8], [90, 8])).toEqual([5])
  })

  it('never yields a negative increment', () => {
    const rand = seeded(11)
    for (let run = 0; run < 200; run++) {
      const last: (number | null)[] = []
      const max: (number | null)[] = []
      let v = 0
      for (let i = 0; i < 30; i++) {
        const r = rand()
        if (r < 0.1) {
          last.push(null)
          max.push(null)
          continue
        }
        let peak = v
        if (r < 0.2) {
          peak = v + Math.floor(rand() * 20)
          v = 0
        }
        v += Math.floor(rand() * 20)
        last.push(v)
        max.push(Math.max(peak, v))
      }
      for (const x of increments(last, max)) expect(x).toBeGreaterThanOrEqual(0)
    }
  })

  it('is empty for one bucket', () => {
    expect(increments([5])).toEqual([])
  })
})

describe('HistoryApiReader request queue', () => {
  it('sends one request at a time, across chunks and callers', async () => {
    let active = 0
    let peak = 0
    let calls = 0
    const fake = new FakeHistory()
    const api = {
      getValues: async (q: Parameters<FakeHistory['getValues']>[0]) => {
        calls++
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return fake.getValues(q)
      },
    }
    const reader = new HistoryApiReader(api as never)
    const paths = Array.from({ length: 90 }, (_, i) => `a.path.${i}`)
    const from = Date.UTC(2030, 0, 1)
    await Promise.all([
      reader.series(paths, 'last', from, from + 3600e3, 300),
      reader.series(paths, 'max', from, from + 3600e3, 300),
    ])
    // 90 paths are three chunks of at most 40, for each of two callers.
    expect(calls).toBe(6)
    expect(peak).toBe(1)
  })

  it('keeps going after a failed request', async () => {
    let first = true
    const fake = new FakeHistory()
    const api = {
      getValues: async (q: Parameters<FakeHistory['getValues']>[0]) => {
        if (first) {
          first = false
          throw new Error('out of memory')
        }
        return fake.getValues(q)
      },
    }
    const reader = new HistoryApiReader(api as never)
    const from = Date.UTC(2030, 0, 1)
    await expect(
      reader.series(['a'], 'last', from, from + 600e3, 300),
    ).rejects.toThrow('out of memory')
    const ok = await reader.series(['a'], 'last', from, from + 600e3, 300)
    expect(ok.times).toHaveLength(2)
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
