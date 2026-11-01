// Propagation alert card on the sectors page (SPEC 7, 9.1): the state, and
// sliders for the factor, vessel count and duration that show at once what
// they would have done over the last hour; users with write access can
// save them.
import { get } from './api'
import { el } from './format'
import { showLoading } from './loading'
import { stateText, trial, trialText, type Propagation } from './propagation'
import {
  SETTINGS_SAVED,
  canSave,
  loginStatus,
  saveError,
  saveSettings,
  type LiveSettings,
} from './settings'
import type { Unit } from './units'

type Key =
  'propagationFactor' | 'propagationMinVessels' | 'propagationSustainMinutes'

interface Slider {
  key: Key
  rule: 'factor' | 'minVessels' | 'sustainMinutes'
  label: string
  min: number
  max: number
  step: number
  format: (v: number) => string
}

const SLIDERS: Slider[] = [
  {
    key: 'propagationFactor',
    rule: 'factor',
    label: 'Range factor',
    min: 1.2,
    max: 10,
    step: 0.1,
    format: (v) => `${v.toFixed(1)} times normal`,
  },
  {
    key: 'propagationMinVessels',
    rule: 'minVessels',
    label: 'Vessels beyond',
    min: 1,
    max: 50,
    step: 1,
    format: (v) => `${v} ${v === 1 ? 'vessel' : 'vessels'}`,
  },
  {
    key: 'propagationSustainMinutes',
    rule: 'sustainMinutes',
    label: 'Duration',
    min: 1,
    max: 60,
    step: 1,
    format: (v) => `${v} min`,
  },
]

export class PropagationPanel {
  readonly element: HTMLElement
  private stateLine = el('p', { role: 'status' })
  private trialLine = el('p', { class: 'muted small', role: 'status' })
  private controls = el('div')
  private inputs = new Map<Key, HTMLInputElement>()
  private outputs = new Map<Key, HTMLOutputElement>()
  private saveBtn = el('button', { type: 'button', hidden: '' }, 'Save')
  private resetBtn = el('button', { type: 'button', hidden: '' }, 'Reset')
  private last?: Extract<Propagation, { enabled: true }>
  /** Values being tried, not saved. */
  private trialValues: Partial<Record<Key, number>> = {}
  private mayWrite = false
  private message = ''

  constructor() {
    for (const s of SLIDERS) {
      const id = `prop-${s.rule}`
      const input = el('input', {
        type: 'range',
        id,
        min: String(s.min),
        max: String(s.max),
        step: String(s.step),
      })
      const output = el('output', { for: id })
      input.addEventListener('input', () => {
        this.trialValues[s.key] = Number(input.value)
        this.message = ''
        this.render()
      })
      this.inputs.set(s.key, input)
      this.outputs.set(s.key, output)
      this.controls.append(
        el(
          'div',
          { class: 'cap-control' },
          el('label', { for: id }, s.label),
          input,
          output,
        ),
      )
    }
    this.controls.append(
      el('div', { class: 'cap-control' }, this.saveBtn, this.resetBtn),
      this.trialLine,
    )
    this.resetBtn.addEventListener('click', () => {
      this.trialValues = {}
      this.message = ''
      this.render()
    })
    this.saveBtn.addEventListener('click', () => this.save())
    this.element = el(
      'div',
      { class: 'sk-card propagation', hidden: '' },
      el('h2', {}, 'Propagation alert'),
      el(
        'p',
        { class: 'muted small' },
        'Raised while the recent p99 distance is the given factor above normal (the median hourly p99 of 7 days) and enough vessels are heard beyond normal, for the given duration. It clears once that has failed for the same duration. Window, notification state and methods are in the plugin config.',
      ),
      this.stateLine,
      this.controls,
    )
    void loginStatus().then((s) => {
      this.mayWrite = canSave(s)
      this.render()
    })
  }

  private units?: Unit
  private formatTime: (t: number) => string = (t) => new Date(t).toISOString()

  async load(units: Unit, formatTime: (t: number) => string): Promise<void> {
    this.units = units
    this.formatTime = formatTime
    const p = await get<Propagation>('/propagation').catch(() => undefined)
    // Off, or a plugin without alerts: no card.
    this.element.hidden = !p?.enabled
    this.last = p?.enabled ? p : undefined
    this.render()
  }

  private saved(key: Key): number | undefined {
    const s = SLIDERS.find((x) => x.key === key)!
    return this.last?.rule[s.rule]
  }

  private render(): void {
    const p = this.last
    if (!p) return
    this.stateLine.textContent = stateText(
      p,
      (m) => this.units?.format(m) ?? `${Math.round(m)} m`,
      this.formatTime,
    )
    for (const s of SLIDERS) {
      const v = this.trialValues[s.key] ?? this.saved(s.key)
      if (v === undefined) continue
      this.inputs.get(s.key)!.value = String(v)
      this.outputs.get(s.key)!.textContent = s.format(v)
    }
    const pending = SLIDERS.some(
      (s) =>
        this.trialValues[s.key] !== undefined &&
        this.trialValues[s.key] !== this.saved(s.key),
    )
    this.saveBtn.hidden = !(pending && this.mayWrite)
    this.resetBtn.hidden = !pending
    const rule = {
      factor: this.trialValues.propagationFactor ?? p.rule.factor,
      minVessels: this.trialValues.propagationMinVessels ?? p.rule.minVessels,
      sustainMinutes:
        this.trialValues.propagationSustainMinutes ?? p.rule.sustainMinutes,
    }
    this.trialLine.textContent =
      this.message ||
      trialText(trial(p, rule)) +
        (pending && !this.mayWrite
          ? ' Saving needs a readwrite or admin login.'
          : '')
  }

  private save(): void {
    const values: Partial<LiveSettings> = {}
    for (const s of SLIDERS) {
      const v = this.trialValues[s.key]
      if (v !== undefined) values[s.key] = v
    }
    this.saveBtn.disabled = true
    const saving = saveSettings(values)
    showLoading(this.saveBtn, saving)
    saving
      .then((s) => {
        if (this.last)
          this.last = {
            ...this.last,
            rule: {
              ...this.last.rule,
              factor: s.propagationFactor,
              minVessels: s.propagationMinVessels,
              sustainMinutes: s.propagationSustainMinutes,
            },
          }
        this.trialValues = {}
        this.message =
          'Saved: the alert uses these settings from the next check.'
        window.dispatchEvent(new Event(SETTINGS_SAVED))
      })
      .catch((err: unknown) => {
        this.message = saveError(err)
        if (/login/.test(this.message)) this.mayWrite = false
      })
      .finally(() => {
        this.saveBtn.disabled = false
        this.render()
      })
  }
}
