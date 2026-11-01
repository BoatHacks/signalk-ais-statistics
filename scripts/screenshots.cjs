// Takes the screenshots listed in package.json (signalk.screenshots) from
// the built plugin and web app, on a synthetic timeline: MMSIs with the
// unassigned MID 999 around 0N 0E, so no real vessel data appears.
// Needs `npm run build` first and Playwright with Chromium installed.
//
//   node scripts/screenshots.cjs [outDir]
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright')

const root = path.join(__dirname, '..')
const out = path.resolve(process.argv[2] ?? path.join(root, 'docs/screenshots'))
const { Aggregator } = require(path.join(root, 'dist/aggregate'))
const { Coverage } = require(path.join(root, 'dist/coverage'))
const { LongRangeLog } = require(path.join(root, 'dist/longrange'))
const { Query } = require(path.join(root, 'dist/query'))
const { nullHistoryReader } = require(path.join(root, 'dist/history'))
const { registerRoutes } = require(path.join(root, 'dist/api'))
const { destination } = require(path.join(root, 'dist/geo'))
const { radarFeatures } = require(path.join(root, 'dist/overlay'))

const API = '/plugins/signalk-ais-statistics'
const APP = '/signalk-ais-statistics'
const OWN = { lat: 0.2, lon: -0.3 }
const NM_PER_M = 0.000539957

function synthetic() {
  const now = Date.now()
  const start = now - 23 * 3600e3
  const agg = new Aggregator(start)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-shots-'))
  const cov = new Coverage(dir, 6, 90, 99, start)
  const log = new LongRangeLog(dir, 14, start)
  let seed = 1
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const quiet = start + 18.8 * 3600e3
  for (let t = start; t < now; t += 20e3) {
    if (t <= quiet && quiet < t + 20e3) {
      // Two far receptions in the quietest hour: a bogus position and one
      // carried by ducting (SPEC 2.3). That hour has too few reports to set
      // a radius, so they show as ticks and in the long-range table.
      for (const [mmsi, type, bearing, d] of [
        [999000901, 1, 300, 2500],
        [999000902, 18, 250, 160],
      ]) {
        const loc = agg.add(
          { type, mmsi: String(mmsi), ...destination(OWN, bearing, d) },
          OWN,
          t,
        )
        if (loc) {
          cov.add(loc.lat, loc.lon, loc.distanceNm, t)
          log.add(loc, agg.vessel(loc.mmsi))
        }
      }
    }
    const busy = 1 + 0.6 * Math.sin((t - start) / 3600e3 / 4)
    const n = Math.floor(rnd() * 8 * busy)
    for (let i = 0; i < n; i++) {
      const mmsi = 999000000 + Math.floor(rnd() * 120)
      const bearing = rnd() * 360
      // An island to the east shortens the range there.
      const range = (bearing > 60 && bearing < 160 ? 12 : 30) * busy
      const d = Math.pow(rnd(), 0.7) * range
      const p = destination(OWN, bearing, d)
      const type = mmsi % 3 === 0 ? 18 : 1
      const loc = agg.add({ type, mmsi: String(mmsi), ...p }, OWN, t)
      if (loc) {
        cov.add(loc.lat, loc.lon, loc.distanceNm, t)
        log.add(loc, agg.vessel(loc.mmsi))
      }
      if (rnd() < 0.05)
        agg.add(
          {
            type: type === 1 ? 5 : 24,
            mmsi: String(mmsi),
            shipType: [30, 37, 60, 70, 80, 52][mmsi % 6],
            name: `SYNTHETIC ${mmsi % 1000}`,
          },
          OWN,
          t,
        )
    }
  }
  return { agg, cov, log }
}

function serve({ agg, cov, log }) {
  const routes = new Map()
  const query = new Query(
    agg,
    () => nullHistoryReader,
    60,
    () => {},
    (from, to) => log.entries(from, to, 400),
  )
  registerRoutes(
    { access: () => ({ get: (p, h) => routes.set(p, h) }) },
    {
      query: () => query,
      coverage: () => cov,
      longRange: () => log,
      overlayExtras: async () =>
        radarFeatures(await query.radar('24h', 'all', Date.now()), OWN),
      status: () => ({
        running: true,
        noData: false,
        trackedTargets: 87,
        ownPositionFresh: true,
        historyAvailable: false,
        lastMessageAt: new Date().toISOString(),
      }),
    },
  )
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }
  const json = (res, body) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost')
    if (u.pathname.startsWith(API)) {
      const h = routes.get(u.pathname.slice(API.length))
      if (!h) return res.writeHead(404).end()
      const r = {
        setHeader: (k, v) => res.setHeader(k, v),
        status: (s) => ((res.statusCode = s), r),
        json: (b) => json(res, b),
      }
      return h({ query: Object.fromEntries(u.searchParams) }, r)
    }
    // Display units as a server with nautical mile preferences reports them.
    if (u.pathname.endsWith('/distance/p99/meta'))
      return json(res, {
        units: 'm',
        displayUnits: { formula: `value * ${NM_PER_M}`, symbol: 'nm' },
      })
    if (u.pathname.endsWith('/coverage/area/today/meta'))
      return json(res, {
        units: 'm2',
        displayUnits: { formula: 'value / 1000000', symbol: 'km²' },
      })
    if (!u.pathname.startsWith(`${APP}/`)) return res.writeHead(404).end()
    const rel = u.pathname.slice(APP.length + 1) || 'index.html'
    const file = path.join(root, 'public', path.normalize(rel))
    if (!file.startsWith(path.join(root, 'public')))
      return res.writeHead(404).end()
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end()
      res.setHeader(
        'content-type',
        types[path.extname(file)] ?? 'application/octet-stream',
      )
      res.end(data)
    })
  })
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, port: server.address().port })),
  )
}

async function main() {
  fs.mkdirSync(out, { recursive: true })
  const { server, port } = await serve(synthetic())
  const browser = await chromium.launch()
  const shots = [
    ['overview', 1280, 900, 'day'],
    ['charts', 1280, 1500, 'day'],
    ['radar', 1280, 900, 'day'],
    ['map', 1280, 900, 'day'],
    ['overview-phone', 390, 844, 'night'],
  ]
  for (const [name, width, height, mode] of shots) {
    const view = name.replace('-phone', '')
    const page = await browser.newPage({ viewport: { width, height } })
    await page.addInitScript(() =>
      localStorage.setItem('signalk-ais-statistics.basemap', 'charts'),
    )
    // A stand-in for the SignalK stream: day or night mode and ship time.
    await page.routeWebSocket(/\/signalk\/v1\/stream/, (ws) => {
      ws.onMessage(() =>
        ws.send(
          JSON.stringify({
            updates: [
              {
                values: [
                  { path: 'environment.mode', value: mode },
                  { path: 'environment.time.timezoneOffset', value: 0 },
                ],
              },
            ],
          }),
        ),
      )
    })
    await page.goto(`http://localhost:${port}${APP}/#/${view}?window=24h`)
    await page.waitForTimeout(1500)
    await page.screenshot({
      path: path.join(out, `${name}.png`),
      fullPage: view !== 'map',
    })
    await page.close()
  }
  await browser.close()
  server.close()
  console.log(`screenshots written to ${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
