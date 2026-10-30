# signalk-ais-statistics Architecture

Requirements live in [SPEC.md](SPEC.md); this document only describes how the
code is organized. Section references like "SPEC 2.3" point there.

## 1. Overview

A SignalK server plugin, written in TypeScript, that listens to raw AIS
sentences, reduces them to per-bucket statistics in memory, and publishes
them as SignalK deltas. Whatever history provider the server has registered
(QuestDB, InfluxDB, any other) records those deltas, and a REST API reads
them back through the SignalK History API for a bundled web app. The
reception footprint is exposed as a plotter extension overlay for chart
plotters, and covered cell sets are kept in small daily files in the
plugin's data directory.

```
 signalk-server
 ├─ sentence events (!AIVDM) ──► Ingest ──► Classifier ──► Aggregator ──► Publisher ──► deltas ──► history provider
 ├─ navigation.position (self) ─► OwnPosition ──┘               │                          │
 │                                                              ▼                          │
 │                                                        Live state                       │
 │                                                              │                          │
 ├─ /plugins/signalk-ais-statistics/* ◄── REST API ◄── Query layer ◄── HistoryReader ◄─────┘
 ├─ public/ web app (graphs, radar, map) ──────────────► REST API
 └─ resources API (plotterExtensions) ◄── Overlay provider ◄── Coverage
```

## 2. System Components

### 2.1 Ingest
Subscribes to the server's raw sentence events, keeps `!AIVDM` and drops
`!AIVDO` (SPEC 5), reassembles multipart messages, and decodes them into
typed message objects (type, MMSI, optional position, optional ship type).
Any prefix before `!` (an NMEA 4.10 tag block) is ignored and any talker id
is accepted. Multipart messages get one decoder session per talker, part
count, sequence id and channel, because ggencoder's single session breaks
when multipart messages interleave; partial messages expire after 10
seconds. Owns nothing persistent. Per-sentence decode errors are counted and
swallowed, never thrown into the server.

### 2.2 OwnPosition
Tracks the latest self `navigation.position` and its timestamp. Exposes
`at(time)` returning the position or `undefined` when stale
(`ownPositionMaxAgeSeconds`). Pure state, no I/O.

### 2.3 Classifier
Maps message type to class and ship type to type group (SPEC 2.1). Nothing
is filtered (SPEC 2.3). Coverage applies its own percentile cap (see 2.5 below).

### 2.4 Aggregator
Keeps the cumulative counters since start, the minute buckets of the last
hour (rolling gauges), the hour buckets of the last 24 hours (live-only
windows and the radar), and a vessel registry of MMSI to last seen and ship
type (pruned after 24 hours, capped at 50000) that answers unique counts
for any window up to 24 hours. For each decoded message it updates counts,
the fixed log-spaced distance histogram of `histogram.ts` (average, median,
p95 and p99 derive from it; the exact maximum is kept beside it) and a
coarse per-sector histogram. Pure and clock-injectable: every call takes
the reception time.

### 2.5 Coverage
Maps each position to an H3 cell (`h3-js`), keeps the cells of the current
UTC day with their shortest distance and report count, and the day's
distance histogram. Flushes hourly to a daily JSON file in the plugin data
directory and reports today's cell count and area to the Publisher. Applies
the `coverageDistancePercentile` cap (SPEC 2.4) when building a window's
footprint, using the distance histograms merged from the day files, so it
needs no history provider. Computes covered area and produces the GeoJSON
used by the map and the overlay.

### 2.6 Publisher
Emits the SignalK deltas of SPEC 6.2 through the plugin API's delta handler,
with the plugin id as source, at the end of every minute. Counters are
running totals since the plugin started; gauges are rolling one-hour or
24-hour figures. Gauges without data are left out (SPEC 6.2).

### 2.7 HistoryReader
The only component that reads history. A small interface
(`series(paths, aggregate, from, to, resolution)`) with an implementation on
the in-process History API (`app.getHistoryApi()`, which returns the
server's default provider) and a null implementation for live-only mode. It
always passes a resolution, uses only `last` and `max`, splits requests into
40 paths, and never talks to a database directly (SPEC 8). The plugin looks
for a provider again every 10 minutes while in live-only mode.

### 2.8 Query layer
Combines the live state (current open bucket) with HistoryReader results to
answer windowed queries. All REST handlers go through it. A window total is
the sum of a counter's per-bucket increments (60, 300 or 3600 second
buckets by window), with reset detection: a value lower than its
predecessor starts a new segment counted from zero, and the bucket's `max`
adds what was counted before a restart inside that bucket. A null before
the first sample counts as zero and a later null as unchanged. Window percentiles come
from the summed increments of the distance bin counters. The one-hour window
uses the live minute buckets once the plugin has run for an hour, since they
are exact. Without history, all answers come from the aggregator.

### 2.9 REST API
Express router registered through the plugin API. Thin: parse and validate
parameters, call the query layer, serialize (SPEC 6.1).

### 2.10 Overlay provider
Registers a read-only `plotterExtensions` resource provider through
`app.registerResourceProvider`, serving the overlay manifest only while the
plugin runs (the pattern `@meri-imperiumi/signalk-internet` uses). The
MapLibre style is inline in the manifest; its GeoJSON source is the
read-only route `/overlay/coverage.geojson`, built on request from Coverage
and the radar. A static background page in the web app bundle calls
`overlay.refresh` hourly through the plotter extension bus (SPEC 6.3).
Nothing is written into the package directory at run time.

### 2.11 Web app
Static bundle under `public/`, served by the server as a SignalK web app.
Talks only to the REST API. No external CDNs for its own assets. Views per
SPEC 7. The map has a basemap switch (OSM/OpenSeaMap or the server's chart
provider); its default follows the internet-status plugin's online and
metered state when present, and a manual choice is remembered in
`localStorage`.

## 3. Data Models

TypeScript interfaces mirror SPEC 4.1 (hour summary) and 4.2 (live state).
Published path names are the persistence schema, so they are defined once in
`paths.ts` and used by both the Publisher and the HistoryReader.

## 4. Technology Stack

| Piece | Choice | Why |
|---|---|---|
| Language | TypeScript 6.0, compiled to CommonJS | matches the plugin API types; the server loads plugins with `require()`; typescript-eslint does not support 7 yet |
| Runtime | Node 22 or newer (the test server runs Node 26) | follow the host |
| Plugin API | `@signalk/server-api` | official types |
| AIS decoding | `ggencoder` ^1.0.8 | already a dependency of the server's `@signalk/nmea0183-signalk` (ggencoder 1.0.13 on the test server, SignalK server 2.35.1), so no new decoder family |
| Geo | own haversine and bearing, `h3-js` for cells | h3-js is pure JS, no native module |
| History | SignalK v2 History API, any provider, read via HistoryReader | chosen by the maintainer; no database dependency |
| Cell sets | JSON files in the plugin data directory | the History API cannot carry id lists |
| Web app | framework-free TypeScript bundled with esbuild, Leaflet for the map, small SVG charts written for the app | bundled locally, phone friendly, no chart dependency |
| Time values for the History API | `@js-temporal/polyfill` | the History API takes `Temporal.Instant` ranges |
| Tests | Vitest, with in-process fakes of the server app and the History API | fast, TypeScript native |

## 5. Integration Points

- **SignalK sentence events**: input for all message statistics, via
  `app.on('nmea0183', handler)`, removed again on stop. The handler receives the raw sentence as a
  plain string, with no source or timestamp, so `!AIVDO` is told apart by
  its prefix and reception time is the time of the call.
- **`navigation.position` (self)**: via
  `app.streambundle.getSelfStream('navigation.position')`.
- **History API**: `app.getHistoryApi()` in process (2.7).
- **Plugin router and delta handler**: output (2.6, 2.9).
- **History provider** (for example `signalk-questdb` here): records the
  deltas; the plugin reads them back only through the History API (2.7) and
  never writes to the provider.
- **Resources API**: `plotterExtensions` provider (2.10); `charts` collection
  read by the web app for the chart-provider basemap.
- **`network.internet.state`**: published by `@meri-imperiumi/signalk-internet`
  (`online`, `offline`, `metered`); read by the web app to choose the
  default basemap.
- **Freeboard-SK**: consumes the plotter extension manifest.

## 6. Security Considerations

- Trust boundary is the AIS feed: any vessel, or anyone with an AIS
  transmitter, can send arbitrary content. The decoder runs on untrusted
  input, so decode failures are contained per sentence, and memory is bounded
  (tracked targets, cell set per day and counters are capped).
- Spoofed positions are the identified practical risk. Distance figures are
  made robust with percentiles (SPEC 2.3) and coverage with a percentile cap
  (SPEC 2.4).
- REST routes are all read-only and are registered for read-only users
  through `router.access('readonly')` (SPEC 6.1). On servers without
  `router.access` they fall back to admin-only. The plugin adds no auth of its own, and exposes no write
  routes.
- History reads are History API requests built from a fixed set of queries
  with validated parameters; no user-supplied paths or SQL.
- Nothing is sent off the boat; the plugin makes no outbound network calls.

## 7. File Structure

```
src/
  index.ts            module export for require()
  plugin.ts           plugin factory, wiring, lifecycle (start/stop)
  config.ts           schema and defaults
  paths.ts            published path names (the persistence schema)
  histogram.ts        distance bin layout and percentiles
  ingest.ts           sentence reassembly and decode
  classify.ts         class and type group
  ownposition.ts      own position and staleness
  aggregate.ts        counters, buckets, sectors, vessel registry
  coverage.ts         H3 cells, daily files, area, GeoJSON
  publish.ts          SignalK deltas
  history.ts          HistoryReader interface and History API implementation
  query.ts            windowed queries
  api.ts              REST routes
  overlay.ts          plotterExtensions provider, manifest and radar wedges
  geo.ts              haversine, bearing, sector
  types/              typings for untyped dependencies
web/src/              web app source, built into public/ by web/build.mjs
web/static/           HTML, CSS and the plotter background page
test/                 unit tests; fixtures/ holds the synthetic sentence
                      builder and fakes of the server app, router and
                      History API
scripts/smoke.cjs     loads the built package with require()
docs/plans/           per-item implementation plans
```

## 8. Deployment

Installed as an npm package into the SignalK server (plugin updates need a
server restart). The data
directory holds only the small daily cell-set files (SPEC 8). Memory is
bounded by the tracked-target cap, open buckets and one day of cells. Needs
a registered History API provider for history; without one the plugin runs
live-only (SPEC 8).

## 9. Future Considerations

- Availability and gap tracking (SPEC 10.2): a separate component with an
  injectable clock, publishing a few more paths; nothing in the MVP blocks it.
- Optional position filtering with counters, if unfiltered coverage proves
  unusable.
- Multiple AIS sources: the sentence event carries no source label, so
  per-receiver statistics would need another input (for example a provider
  specific stream). Not designed for now.
