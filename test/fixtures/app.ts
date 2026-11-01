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
  const metadata = new Map<string, { units?: string }>()
  const errors: string[] = []
  /** What the server stores for the plugin, as readPluginOptions returns it. */
  const stored: { enabled: boolean; configuration: object } = {
    enabled: true,
    configuration: {},
  }
  const saves: object[] = []
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
    setDefaultMetadata: async (path: string, meta: { units?: string }) => {
      metadata.set(path, meta)
      return true
    },
    error: (s: string) => errors.push(s),
    readPluginOptions: () => stored,
    // Like the server: replaces the whole configuration, no restart.
    savePluginOptions: (
      configuration: object,
      cb: (err: Error | null) => void,
    ) => {
      saves.push(configuration)
      stored.configuration = configuration
      queueMicrotask(() => cb(null))
    },
    debug: () => undefined,
    ...(history ? { getHistoryApi: async () => history } : {}),
  }
  return {
    app,
    deltas,
    providers,
    statuses,
    metadata,
    errors,
    stored,
    saves,
    position(lat: number, lon: number) {
      for (const f of positionListeners) f({ latitude: lat, longitude: lon })
    },
    positionListeners,
  }
}
