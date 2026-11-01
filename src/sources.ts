// Per-source statistics (SPEC 5, #14): one aggregator per configured server
// event, opt-in through `sourceStatistics`. Each sees the same messages its
// event delivers to the main aggregator, which stays unchanged: nothing is
// filtered, and a receiver on two events still counts twice in the main
// figures. Only counters are published per source (messages, positions,
// distance bins, health); window figures come from the bin increments.
import { Aggregator } from './aggregate'
import {
  DISTANCE_BIN_COUNT,
  HEALTH_KINDS,
  counterPaths,
  sourceLabels,
  sourcePaths,
} from './paths'
import type { PathValue } from './publish'

export interface Source {
  event: string
  /** The path label, from the event name (`sourceLabel`). */
  label: string
  agg: Aggregator
  /** The counters a query reads for this source. */
  counters: string[]
}

export class Sources {
  readonly list: Source[]
  /** Events whose label got a `_2`, `_3` suffix to stay unique. */
  readonly collisions: string[]
  private readonly byEvent = new Map<string, Source>()
  private readonly byLabel = new Map<string, Source>()

  constructor(events: string[], now: number) {
    const { labels, collisions } = sourceLabels(events)
    this.collisions = collisions
    this.list = [...labels].map(([event, label]) => ({
      event,
      label,
      agg: new Aggregator(now),
      counters: counterPaths(label),
    }))
    for (const s of this.list) {
      this.byEvent.set(s.event, s)
      this.byLabel.set(s.label, s)
    }
  }

  event(event: string): Source | undefined {
    return this.byEvent.get(event)
  }

  label(label: string): Source | undefined {
    return this.byLabel.get(label)
  }

  /** The counters of every source, for each publish interval. */
  values(): PathValue[] {
    const out: PathValue[] = []
    for (const s of this.list) {
      const p = sourcePaths(s.label)
      const t = s.agg.totals
      out.push(
        { path: p.messagesTotal, value: t.messages },
        { path: p.positionsClassA, value: t.positions.A },
        { path: p.positionsClassB, value: t.positions.B },
        { path: p.positionsOther, value: t.positions.other },
      )
      for (let i = 0; i < DISTANCE_BIN_COUNT; i++)
        out.push({ path: p.distanceBin(i), value: t.distanceBins[i] ?? 0 })
      for (const k of HEALTH_KINDS)
        out.push({ path: p.health(k), value: t.health[k] })
    }
    return out
  }
}
