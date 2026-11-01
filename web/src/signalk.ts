// Live connection to the SignalK server for the few values the app shows
// around the statistics: day or night mode, the ship's time zone and the
// internet state. One WebSocket, throttled subscriptions, reconnect with
// backoff, and an offline flag the app shows while the socket is down.
import { backoffDelay } from './backoff'
import { parseOffset } from './time'
import type { DisplayUnits } from './units'

export interface LiveState {
  connected: boolean
  /** Seconds until the next reconnect attempt while disconnected. */
  retryInS: number | null
  mode: 'day' | 'night'
  /** Ship time offset from UTC in minutes, when the vessel publishes it. */
  offsetMin: number | undefined
  internet: string | undefined
}

const PATHS = [
  'environment.mode',
  'environment.time.timezoneOffset',
  'network.internet.state',
]
// Nothing here changes quickly, so ask for at most one update every 5 s.
const PERIOD_MS = 5000

export function connectLive(onChange: (s: LiveState) => void): void {
  const state: LiveState = {
    connected: false,
    retryInS: null,
    mode: 'day',
    offsetMin: undefined,
    internet: undefined,
  }
  let attempt = 0
  const emit = () => onChange({ ...state })

  const apply = (path: string, value: unknown) => {
    if (path === 'environment.mode')
      state.mode = value === 'night' ? 'night' : 'day'
    else if (path === 'environment.time.timezoneOffset')
      state.offsetMin = parseOffset(value)
    else if (path === 'network.internet.state')
      state.internet = typeof value === 'string' ? value : undefined
  }

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let ws: WebSocket
    try {
      ws = new WebSocket(
        `${proto}://${location.host}/signalk/v1/stream?subscribe=none`,
      )
    } catch {
      retry()
      return
    }
    ws.addEventListener('open', () => {
      attempt = 0
      state.connected = true
      state.retryInS = null
      ws.send(
        JSON.stringify({
          context: 'vessels.self',
          subscribe: PATHS.map((path) => ({
            path,
            period: PERIOD_MS,
            minPeriod: PERIOD_MS,
          })),
        }),
      )
      emit()
    })
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          updates?: { values?: { path: string; value: unknown }[] }[]
        }
        let changed = false
        for (const u of msg.updates ?? [])
          for (const v of u.values ?? []) {
            apply(v.path, v.value)
            changed = true
          }
        if (changed) emit()
      } catch {
        // not a delta
      }
    })
    ws.addEventListener('close', () => {
      state.connected = false
      retry()
    })
  }

  const retry = () => {
    const delay = backoffDelay(attempt++)
    state.retryInS = Math.round(delay / 1000)
    emit()
    setTimeout(open, delay)
  }

  emit()
  open()
}

export interface PathMeta {
  /** The SI unit of the path, such as Pa or K. */
  units?: string
  displayUnits?: DisplayUnits
}

/** The path's metadata from the full tree, if the server has it. */
export async function pathMeta(path: string): Promise<PathMeta | undefined> {
  try {
    const res = await fetch(
      `/signalk/v1/api/vessels/self/${path.replace(/\./g, '/')}/meta`,
      { credentials: 'same-origin' },
    )
    if (!res.ok) return undefined
    const meta = (await res.json()) as PathMeta
    return {
      units: typeof meta.units === 'string' ? meta.units : undefined,
      displayUnits: meta.displayUnits,
    }
  } catch {
    return undefined
  }
}

/** The path's `meta.displayUnits` from the full tree, if the server has it. */
export async function displayUnits(
  path: string,
): Promise<DisplayUnits | undefined> {
  return (await pathMeta(path))?.displayUnits
}
