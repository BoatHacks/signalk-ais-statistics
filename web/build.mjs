// Builds the web app and the plotter extension files into public/, which
// the SignalK server serves at /signalk-ais-statistics/. Everything is
// bundled locally: the app must work offline and over metered links.
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  entryPoints: [join(root, 'web/src/main.ts')],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'iife',
  target: ['es2020'],
  outfile: join(out, 'app.js'),
  loader: { '.png': 'dataurl', '.svg': 'dataurl' },
})

cpSync(join(root, 'web/static'), out, { recursive: true })
cpSync(
  join(root, 'node_modules/leaflet/dist/leaflet.css'),
  join(out, 'leaflet.css'),
)
console.log('web app built into public/')
