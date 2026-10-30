// Loads the built plugin the way the SignalK server does, with require(),
// and checks that the module itself is the plugin factory.
const factory = require('..')
if (typeof factory !== 'function') throw new Error('module is not a factory')
const plugin = factory({})
if (plugin.id !== 'signalk-ais-statistics') throw new Error('unexpected id')
if (typeof plugin.schema() !== 'object') throw new Error('no schema')
console.log('smoke test passed')
