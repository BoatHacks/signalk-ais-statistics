import type { Plugin, ServerAPI } from '@signalk/server-api'
import { configSchema, resolveConfig } from './config'

export const PLUGIN_ID = 'signalk-ais-statistics'

export function createPlugin(app: ServerAPI): Plugin {
  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'AIS Statistics',
    description:
      'AIS reception statistics: counts, distance percentiles, bearing radar and coverage',
    schema: () => configSchema,
    start(options) {
      resolveConfig(options)
      app.setPluginStatus('Started')
    },
    stop() {},
  }
  return plugin
}
