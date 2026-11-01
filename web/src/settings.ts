// Live settings (SPEC 9.1): values the user can try in the web app and, with
// write access, save to the plugin config through POST /settings.
import { API, HttpError } from './api'

/** What the server's /skServer/loginStatus answers, as far as used here. */
export interface LoginStatus {
  status?: string
  authenticationRequired?: boolean
  userLevel?: string
}

/**
 * Whether the save button is offered: always while security is off,
 * otherwise only to logged in readwrite and admin users. The server checks
 * again on every save, so this only avoids offering what would be refused.
 */
export function canSave(s: LoginStatus | undefined): boolean {
  if (!s) return false
  if (s.authenticationRequired === false) return true
  return (
    s.status === 'loggedIn' &&
    (s.userLevel === 'readwrite' || s.userLevel === 'admin')
  )
}

/** Window event after a save, so views showing settings can reload. */
export const SETTINGS_SAVED = 'ais-settings-saved'

let login: Promise<LoginStatus | undefined> | undefined

/** The login status, read once per page load: the route is rate limited. */
export function loginStatus(): Promise<LoginStatus | undefined> {
  login ??= fetch('/skServer/loginStatus', { credentials: 'same-origin' })
    .then((r) => (r.ok ? (r.json() as Promise<LoginStatus>) : undefined))
    .catch(() => undefined)
  return login
}

export interface LiveSettings {
  coverageDistancePercentile: number
  propagationFactor: number
  propagationMinVessels: number
  propagationSustainMinutes: number
}

/** Saves live settings; answers the effective values. */
export async function saveSettings(
  values: Partial<LiveSettings>,
): Promise<LiveSettings> {
  const res = await fetch(`${API}/settings`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg
    } catch {
      // not JSON
    }
    throw new HttpError(res.status, msg)
  }
  return ((await res.json()) as { settings: LiveSettings }).settings
}

/** "99th percentile", or "off" at 100. */
export function capLabel(percentile: number): string {
  if (percentile >= 100) return 'off'
  const n = Math.round(percentile)
  const teen = n % 100 >= 11 && n % 100 <= 13
  const suffix = teen
    ? 'th'
    : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ??
      'th')
  return `${n}${suffix} percentile`
}

/** Why a save failed, in words for the user. */
export function saveError(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403))
    return 'Saving needs a readwrite or admin login on the SignalK server.'
  if (err instanceof HttpError && err.status === 503)
    return 'The plugin is not running, so nothing was saved.'
  return `Could not save: ${err instanceof Error ? err.message : String(err)}`
}
