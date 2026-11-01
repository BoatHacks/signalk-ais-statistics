// In-process fake of a History API provider, behaving like the provider
// recorded in docs/findings.md: buckets start at the request's `from`,
// `last` returns null before the first sample and repeats the previous
// value for buckets without a new sample; `max` and `average` are null for
// buckets without samples. Aggregates listed in `rejects` fail the request,
// like a provider that does not offer them.
import type { HistoryApi, ValuesRequest } from '@signalk/server-api/history'
import type { PathValue } from '../../src/publish'

interface Sample {
  time: number
  value: number
}

export class FakeHistory implements HistoryApi {
  private samples = new Map<string, Sample[]>()
  requests: ValuesRequest[] = []
  rejects = new Set<string>()

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
    for (const spec of query.pathSpecs)
      if (this.rejects.has(spec.aggregate))
        throw new Error(`unsupported aggregate ${spec.aggregate}`)
    const from = query.from.epochMilliseconds
    const to = query.to.epochMilliseconds
    const step = query.resolution * 1000
    const data: [string, ...(number | null)[]][] = []
    for (let t = from; t < to; t += step) {
      const row: [string, ...(number | null)[]] = [new Date(t).toISOString()]
      for (const spec of query.pathSpecs) {
        const list = this.samples.get(spec.path) ?? []
        if (spec.aggregate === 'last') {
          const before = list.filter((s) => s.time < t + step)
          row.push(before.length ? before[before.length - 1]!.value : null)
        } else {
          const inside = list
            .filter((s) => s.time >= t && s.time < t + step)
            .map((s) => s.value)
          row.push(
            inside.length === 0
              ? null
              : spec.aggregate === 'average'
                ? inside.reduce((a, b) => a + b, 0) / inside.length
                : Math.max(...inside),
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
