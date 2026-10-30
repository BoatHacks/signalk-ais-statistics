// A fake SignalK server app with just what the plugin uses.
import { EventEmitter } from 'node:events'
import { FakeHistory } from './history'

/** With a FakeHistory, published deltas are recorded the way a provider would. */
export function fakeApp(dataDir: string, history?: FakeHistory) {
  const emitter = new EventEmitter()
  const positionListeners = new Set<(v: unknown) => void>()
  const deltas: {
    id: string
    delta: { updates: { values: { path: string; value: number }[] }[] }
  }[] = []
  const providers: {
    type: string
    methods: Record<string, (...a: unknown[]) => Promise<unknown>>
  }[] = []
  const statuses: string[] = []
  const errors: string[] = []
  const app = {
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    emit: emitter.emit.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
    streambundle: {
      getSelfStream: () => ({
        onValue(f: (v: unknown) => void) {
          positionListeners.add(f)
          return () => positionListeners.delete(f)
        },
      }),
    },
    handleMessage: (id: string, delta: (typeof deltas)[number]['delta']) => {
      deltas.push({ id, delta })
      for (const u of delta.updates) history?.record(u.values, Date.now())
    },
    getDataDirPath: () => dataDir,
    registerResourceProvider: (p: never) => providers.push(p),
    setPluginStatus: (s: string) => statuses.push(s),
    error: (s: string) => errors.push(s),
    debug: () => undefined,
    ...(history ? { getHistoryApi: async () => history } : {}),
  }
  return {
    app,
    deltas,
    providers,
    statuses,
    errors,
    position(lat: number, lon: number) {
      for (const f of positionListeners) f({ latitude: lat, longitude: lon })
    },
    positionListeners,
  }
}
