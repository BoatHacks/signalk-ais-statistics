// Range vs weather panel on the charts view (SPEC 7): hourly p99 range
// next to one weather series read back from history, and a scatter of the
// two with Pearson's r. Shown only with a history provider and weather in
// it; the plugin keeps no weather of its own.
import type { Series, Weather } from './api'
import { Chart } from './charts'
import { el } from './format'
import { ScatterChart } from './scatter'
import { pathMeta } from './signalk'
import {
  MIN_HOUR_REPORTS,
  MIN_PAIRS,
  difference,
  pairHours,
  pearson,
} from './stats'
import { quantityUnit, type Unit } from './units'

const AIR = 'environment.outside.temperature'
const WATER = 'environment.water.temperature'
/** The derived series, offered when both temperatures have data. */
export const AIR_MINUS_WATER = 'airMinusWater'

const LABELS: Record<string, string> = {
  'environment.outside.pressure': 'Air pressure',
  [AIR]: 'Air temperature',
  'environment.outside.relativeHumidity': 'Humidity',
  [WATER]: 'Water temperature',
  [AIR_MINUS_WATER]: 'Air minus water temperature',
}

const KEY = 'signalk-ais-statistics.weatherSeries'

export function weatherLabel(path: string): string {
  return LABELS[path] ?? path
}

function savedChoice(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function saveChoice(path: string): void {
  try {
    localStorage.setItem(KEY, path)
  } catch {
    // storage unavailable, the choice lasts for this page only
  }
}

export interface WeatherInput {
  /** The hourly distance series of the charts view. */
  distance: Series
  /** Null when the window is too short or the request failed. */
  weather: Weather | null
  shortWindow: boolean
  distanceUnit: Unit
  offsetMin: number | undefined
}

export class WeatherPanel {
  readonly element: HTMLElement
  private readonly note: HTMLElement
  private readonly select: HTMLSelectElement
  private readonly body: HTMLElement
  private readonly chart: Chart
  private readonly scatter: ScatterChart
  private readonly units = new Map<string, Promise<Unit>>()
  private last: WeatherInput | undefined
  private options = ''

  constructor(rangeColor: string, weatherColor: string) {
    this.note = el('p', { class: 'muted small' })
    this.select = el('select', { 'aria-label': 'Weather series' })
    this.select.addEventListener('change', () => {
      saveChoice(this.select.value)
      if (this.last) void this.update(this.last)
    })
    this.chart = new Chart('line', [
      { name: 'p99 range', color: rangeColor },
      { name: 'Weather', color: weatherColor, axis: 'right' },
    ])
    this.scatter = new ScatterChart(rangeColor, 'Weather', 'p99 range')
    this.body = el(
      'div',
      {},
      el('label', { class: 'weather-pick' }, 'Compare with ', this.select),
      this.chart.element,
      el('h3', {}, 'Hourly p99 range against the weather'),
      this.scatter.element,
    )
    this.element = el(
      'section',
      { hidden: '' },
      el('h2', {}, 'Range vs weather'),
      this.note,
      this.body,
    )
  }

  private unit(path: string): Promise<Unit> {
    let u = this.units.get(path)
    if (!u) {
      u = pathMeta(path).then((m) => quantityUnit(m?.units, m?.displayUnits))
      this.units.set(path, u)
    }
    return u
  }

  async update(input: WeatherInput): Promise<void> {
    this.last = input
    const w = input.weather
    if (input.shortWindow) {
      this.show('Range vs weather needs the 24h or 7d window.', false)
      return
    }
    if (!w || !w.available) {
      this.element.hidden = true
      return
    }
    if (w.historyError) {
      this.show(w.historyError, false)
      return
    }
    if (w.series.length === 0) {
      this.element.hidden = true
      return
    }

    const paths = w.series.map((s) => s.path)
    const choices = [...paths]
    if (paths.includes(AIR) && paths.includes(WATER))
      choices.push(AIR_MINUS_WATER)
    const signature = choices.join(',')
    if (signature !== this.options) {
      this.options = signature
      this.select.replaceChildren(
        ...choices.map((p) => el('option', { value: p }, weatherLabel(p))),
      )
    }
    const saved = savedChoice()
    const prev = this.select.value
    this.select.value = choices.includes(prev)
      ? prev
      : saved !== null && choices.includes(saved)
        ? saved
        : choices[0]!
    const choice = this.select.value

    // Weather in display units; the difference is taken in display units
    // too, so an offset such as Celsius or Fahrenheit cancels out.
    const display = async (path: string) => {
      const u = await this.unit(path)
      const col = w.series.find((s) => s.path === path)?.values ?? []
      return { u, values: col.map((v) => (v === null ? null : u.toDisplay(v))) }
    }
    let unit: Unit
    let values: (number | null)[]
    if (choice === AIR_MINUS_WATER) {
      const [a, b] = await Promise.all([display(AIR), display(WATER)])
      unit = a.u
      values = difference(a.values, b.values)
    } else {
      const d = await display(choice)
      unit = d.u
      values = d.values
    }
    if (this.last !== input) return

    const du = input.distanceUnit
    const dist = input.distance
    const p99 = ((dist.p99M as (number | null)[]) ?? []).map((v) =>
      v === null ? null : du.toDisplay(v),
    )
    const count = ((dist.count as (number | null)[]) ?? []).map((v) => v ?? 0)
    const rangeTimes = dist.times.map((t) => Date.parse(t))
    const times = w.times.map((t) => Date.parse(t))
    const p99At = new Map(rangeTimes.map((t, i) => [t, p99[i] ?? null]))

    const label = weatherLabel(choice)
    this.chart.rename(1, label)
    this.chart.update({
      times,
      columns: [times.map((t) => p99At.get(t) ?? null), values],
      format: du.formatDisplay,
      formatRight: unit.formatDisplay,
      offsetMin: input.offsetMin,
    })
    const pairs = pairHours(
      { times: rangeTimes, p99, count },
      { times, values },
    )
    const r = pearson(pairs)
    this.scatter.update(
      {
        points: pairs,
        formatX: unit.formatDisplay,
        formatY: du.formatDisplay,
        caption:
          r === null
            ? `Too few hours for a correlation: ${pairs.length} with at least ${MIN_HOUR_REPORTS} reports, ${MIN_PAIRS} needed.`
            : `r = ${r.toFixed(2)} (n = ${pairs.length} hours with at least ${MIN_HOUR_REPORTS} reports)`,
      },
      label,
    )
    this.show(
      w.aggregate === 'average'
        ? 'Hourly averages of the weather from the server history.'
        : 'The last weather value of each hour from the server history; the history provider does not offer averages.',
      true,
    )
  }

  private show(note: string, body: boolean): void {
    this.note.textContent = note
    this.body.hidden = !body
    this.element.hidden = false
  }
}
