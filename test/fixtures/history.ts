// In-process fake of a History API provider, behaving like the provider
// recorded in docs/findings.md: `last` returns null before the first sample
// and repeats the previous value for buckets without a new sample; `max` is
// null for buckets without samples.
import type { HistoryApi, ValuesRequest } from '@signalk/server-api/history'
import type { PathValue } from '../../src/publish'

interface Sample {
  time: number
  value: number
}

export class FakeHistory implements HistoryApi {
  private samples = new Map<string, Sample[]>()
  requests: ValuesRequest[] = []

  record(values: PathValue[], time: number): void {
    for (const v of values) {
      let list = this.samples.get(v.path)
      if (!list) this.samples.set(v.path, (list = []))
      list.push({ time, value: v.value })
    }
  }

  async getValues(query: ValuesRequest) {
    this.requests.push(query)
    if (!query.from || !query.to || !query.resolution)
      throw new Error('fake history needs from, to and resolution')
    const from = query.from.epochMilliseconds
    const to = query.to.epochMilliseconds
    const step = query.resolution * 1000
    const data: [string, ...(number | null)[]][] = []
    for (let t = Math.floor(from / step) * step; t < to; t += step) {
      const row: [string, ...(number | null)[]] = [new Date(t).toISOString()]
      for (const spec of query.pathSpecs) {
        const list = this.samples.get(spec.path) ?? []
        if (spec.aggregate === 'last') {
          const before = list.filter((s) => s.time < t + step)
          row.push(before.length ? before[before.length - 1]!.value : null)
        } else {
          const inside = list.filter((s) => s.time >= t && s.time < t + step)
          row.push(
            inside.length ? Math.max(...inside.map((s) => s.value)) : null,
          )
        }
      }
      data.push(row)
    }
    return {
      context: 'vessels.self' as never,
      range: {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      } as never,
      values: query.pathSpecs.map((s) => ({
        path: s.path,
        method: s.aggregate,
      })),
      data: data as never,
    }
  }

  async getContexts() {
    return []
  }

  async getPaths() {
    return []
  }
}
