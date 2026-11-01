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
 ├─ AIS events (!AIVDM, PGNs) ─► Ingest ──► Classifier ──► Aggregator ──► Publisher ──► deltas ──► history provider
 ├─ navigation.position (self) ─► OwnPosition ──┘               │                          │
 │                                                              ▼                          │
 │                                                        Live state                       │
 │                                                              │                          │
 ├─ /plugins/signalk-ais-statistics/* ◄── REST API ◄── Query layer ◄── HistoryReader ◄─────┘
 ├─ public/ web app (graphs, sectors, map) ────────────► REST API
 └─ resources API (plotterExtensions) ◄── Overlay provider ◄── Coverage
```

## 2. System Components

### 2.1 Ingest
Subscribes to the server's raw sentence events, keeps `!AIVDM` and drops
`!AIVDO` (SPEC 5), reassembles multipart messages, and decodes them into
typed message objects (type, MMSI, optional position, ship type, name,
reported speed over ground in m/s and message 24 part).
Any prefix before `!` (an NMEA 4.10 tag block) is ignored and any talker id
is accepted. Multipart messages get one decoder session per talker, part
count, sequence id and channel, because ggencoder's single session breaks
when multipart messages interleave; partial messages expire after 10
seconds. Owns nothing persistent. Per-sentence decode errors are counted and
swallowed, never thrown into the server.

NMEA 2000 input arrives on `N2KAnalyzerOut` as PGN objects already decoded
by the server's canboatjs. `N2kIngest` (`src/n2k.ts`) keeps the AIS PGNs,
drops those whose transceiver field marks the own transponder, and maps
message id, MMSI, position, ship type and speed over ground onto the same
message objects,
turning canboat lookup names back into AIS codes with a local copy of the
canboat tables (`src/n2k-lookups.ts`, checked against `@canboat/ts-pgns` in
a test) and padding MMSIs to nine digits as the sentence decoder does.
Each event gets both decoders; strings go to the sentence decoder and
objects to `N2kIngest`. The plugin counts the rise of each decoder's
decode error and incomplete counts at the time of the push as message
health (SPEC 2.8).

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
windows and the sectors), and a vessel registry of MMSI to last seen, ship
type and name (pruned after 24 hours, capped at 50000) that answers unique counts
for any window up to 24 hours. For each decoded message it updates counts,
the fixed log-spaced distance histogram of `histogram.ts` (average, median,
p95 and p99 derive from it; the exact maximum is kept beside it) and a
coarse per-sector histogram with the farthest reception per sector and its
time. A located report comes back with its bearing, class and the own
position, for Coverage and the long-range log. Every count, including
the message health counters (SPEC 2.8), lives in the totals and in each
bucket, so live-only windows have health figures too. The aggregator
counts invalid positions and reports without own position itself; the
other health kinds come in through `countHealth`. Pure and
clock-injectable: every call takes the reception time.

### 2.4a Health
`health.ts` judges each decoded message before the aggregator counts it
(SPEC 2.8): the duplicate detector keeps the copies of the last 2 s per
MMSI, type and part, and the jump tracker an anchor position per sender
(pruned after `targetExpirySeconds`, capped like the vessel registry). One
instance serves every configured event, because only a shared detector
sees a message arrive on two events. It returns a verdict (duplicate kind,
implied speed sample) and keeps no counts; the plugin hands the counts to
the aggregator and the speed sample to the long-range log. Pure and
clock-injectable.

### 2.5a Long-range log
`longrange.ts` keeps, per UTC day, the farthest reception of each MMSI up
to the 50 farthest (SPEC 2.7), fills in names the registry learns later
that day, and writes `longrange-YYYY-MM-DD.json` beside the coverage files
hourly, at the day change and on stop. Writes are queued so two never
share a temporary file. Earlier days are read on first use and pruned with
`coverageRetentionDays`. It also gives the sectors exact times for the
sector maxima read from history. The same file (version 2) holds the
day's fastest senders by implied speed, 10 plausible and 10 implausible
(SPEC 2.8); a version 1
file loads with an empty list.

### 2.5 Coverage
Maps each position to an H3 cell (`h3-js`), keeps the cells of the current
UTC day with their shortest distance and report count, and the day's
distance histogram. Flushes hourly to a daily JSON file in the plugin data
directory and reports today's cell count and area to the Publisher. Applies
the `coverageDistancePercentile` cap to cells with fewer than 3 reports
(`MIN_FAR_CELL_REPORTS`, SPEC 2.4) when building a window's
footprint, using the distance histograms merged from the day files, so it
needs no history provider. Computes covered area and produces the GeoJSON
used by the map and the overlay.

### 2.6 Publisher
Emits the SignalK deltas of SPEC 6.2 through the plugin API's delta handler,
with the plugin id as source, at the end of every publish interval (5
minutes by default, a divisor of the hour); the sector paths go out on the
tick that closes each hour, on the first tick after a start and on stop.
Counters are
running totals since the plugin started; gauges are rolling one-hour or
24-hour figures. Gauges without data are left out (SPEC 6.2).
Distances and areas are converted from the internal nautical miles and
square kilometres to metres and square metres here and at the REST
boundary, and default SI metadata is suggested on start.

### 2.7 HistoryReader
The only component that reads history. A small interface
(`series(paths, aggregate, from, to, resolution)`) with an implementation on
the in-process History API (`app.getHistoryApi()`, which returns the
server's default provider) and a null implementation for live-only mode. It
always passes a resolution, uses only `last` and `max`, splits requests into
40 paths, sends them one at a time across all callers, and never talks to
a database directly (SPEC 8). The plugin looks
for a provider again every 10 minutes while in live-only mode.

### 2.8 Query layer
Combines the live state (current open bucket) with HistoryReader results to
answer windowed queries. All REST handlers go through it. A window total is
the sum of a counter's per-bucket increments (60, 300 or 3600 second
buckets by window, never finer than the publish interval), with reset detection: a value lower than its
predecessor starts a new segment counted from zero, and the bucket's `max`
adds what was counted before a restart inside that bucket (a `max` above
the bucket's `last` also marks one). Series start on a whole multiple of
their resolution, so hourly bars begin on the hour. The sectors query reads the
closed hours from history and adds the open hour from the live bucket,
because the sector paths are published hourly. Only hours with at least
20 reports in a sector count toward its p99 (`MIN_SECTOR_REPORTS`). The
sector maxima come from the live buckets with their exact time, or from the
hourly `max` paths with the hour's start, which a matching long-range log
entry (same sector and class, within a metre) replaces with the exact time. A null before
the first sample counts as zero and a later null as unchanged. Window percentiles come
from the summed increments of the distance bin counters. The one-hour window
and chart spans of up to an hour use the live minute buckets once the
plugin has run for an hour, since they are exact. Without history, all
answers come from the aggregator, and if a history read fails the answer
falls back to them with a short `historyError` note (the provider's error
goes to the server log).

### 2.9 REST API
Express router registered through the plugin API. Thin: parse and validate
parameters, call the query layer, serialize (SPEC 6.1). Data routes reuse
an answer for a minute per set of parameters and share in-flight
computations; `/status` is never cached. The one write route, `POST
/settings`, validates live settings with `parseLiveSettings` from
`config.ts` and hands them to the plugin, which merges them into the stored
configuration, saves it and applies them (for example
`Coverage.setPercentile`); the route then clears every answer cache.
The download routes under `/export/` read the same day files through
`Coverage.footprint` and `LongRangeLog.entries` (every entry, no limit;
the day files bound it) and hand them to the pure serializers in
`export.ts`; `handleFile` sends the string as an attachment, with errors
still as JSON. Their `all` window reaches back `coverageRetentionDays`,
which the plugin passes in as `retentionDays`.

### 2.10 Overlay provider
Registers a read-only `plotterExtensions` resource provider through
`app.registerResourceProvider`, serving the overlay manifest only while the
plugin runs (the pattern `@meri-imperiumi/signalk-internet` uses). The
MapLibre style is inline in the manifest; its GeoJSON source is the
read-only route `/overlay/coverage.geojson`, built on request from Coverage
and the class A and B sectors (`sector` wedges and `sector-max` lines,
each with its class in `cls`). A static background page in the web app bundle calls
`overlay.refresh` hourly through the plotter extension bus (SPEC 6.3).
Nothing is written into the package directory at run time.

### 2.11 Web app
Static bundle under `public/`, served by the server as a SignalK web app.
Statistics come from the REST API; a single SignalK WebSocket carries
`environment.mode`, the ship's time offset and the internet state. No
external CDNs for its own assets. Views per SPEC 7, each a custom element
that builds its DOM once and then updates text and attributes only;
charts reuse their SVG paths and rects. Pure helpers (`units.ts`,
`time.ts`, `route.ts`, `backoff.ts`, `health.ts`) are unit tested under
`test/web`. The overview's health section, its good share and the
duplicate hint come from `health.ts`; the charts derive the class A and B
mix from the `positions` series. The map has a basemap switch (OSM/OpenSeaMap or the server's chart
provider); its default follows the internet-status plugin's online and
metered state when present, and a manual choice is remembered in
`localStorage`. Toggles show or hide the coverage cells, the cells beyond
the distance cap (fetched with `all=true`, drawn dashed, off by default)
and the class A and B sectors (`layers.ts`, also remembered in
`localStorage`). The distance cap slider under the map refetches
`/coverage` with `cap` and, through `settings.ts`, saves with `POST
/settings`; the save button shows when `/skServer/loginStatus`, read once
per page load because the server rate limits it, reports security off or a
readwrite or admin user. The sectors view draws the sector maxima as ticks with a wide invisible hover line,
leaves a quarter more room on the scale for them, and lists `/longrange`
in tables: the farthest receptions, the fastest vessels and the
implausible jumps. Plain `<a download>` links to the export routes (`downloads.ts`,
URLs from `exportHref` in `api.ts`) sit under the map and the farthest
receptions table; the browser sends the session cookie with them. The map's sector wedges
come from the overlay GeoJSON route, and the cell and sector colours are
imported from `src/style.ts`, which the plotter overlay uses too, so the
app map and the plotter look the same.

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
| NMEA 2000 lookups | local copy in `src/n2k-lookups.ts`, `@canboat/ts-pgns` ^3.1.0 as a dev dependency | the canboat lookup tables that the server's canboatjs and n2k-signalk use, so names map back to the same codes; the package unpacks to 6.5 MB, so only a test uses it to check the copy |
| Geo | own haversine and bearing, `h3-js` for cells | h3-js is pure JS, no native module |
| History | SignalK v2 History API, any provider, read via HistoryReader | chosen by the maintainer; no database dependency |
| Cell sets | JSON files in the plugin data directory | the History API cannot carry id lists |
| Web app | framework-free TypeScript bundled with esbuild, Leaflet for the map, small SVG charts written for the app | bundled locally, phone friendly, no chart dependency |
| Time values for the History API | `@js-temporal/polyfill` | the History API takes `Temporal.Instant` ranges |
| Tests | Vitest, with in-process fakes of the server app and the History API | fast, TypeScript native |

## 5. Integration Points

- **SignalK AIS events**: input for all message statistics, via
  `app.on(event, handler)` for each event in `sentenceEvents` (default
  `nmea0183` and `N2KAnalyzerOut`), each with its own `Ingest` and
  `N2kIngest`, removed again on stop. Sentence events pass the raw
  sentence as a plain string, with no source or timestamp, so `!AIVDO` is
  told apart by its prefix; `N2KAnalyzerOut` passes canboatjs PGN objects.
  Reception time is the time of the call.
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
  (tracked targets, cell set per day, long-range log entries and counters
  are capped). Vessel names are cut to 40 characters and shown as text,
  never as HTML. In CSV downloads a text field that a spreadsheet would
  read as a formula gets a leading apostrophe.
- Downloads carry MMSIs, names and both positions by default, for the
  boat's own use. Anonymise drops all of them from the long-range export;
  the coverage file is never anonymised and the web app says that a
  footprint can hint at the berth (SPEC 6.1).
- Spoofed positions are the identified practical risk. Distance figures are
  made robust with percentiles (SPEC 2.3) and coverage with a percentile cap
  (SPEC 2.4).
- The read routes are registered for read-only users through
  `router.access('readonly')` (SPEC 6.1). The one write route, `POST
  /settings`, is registered through `router.access('readwrite')` and
  changes only the live settings (SPEC 9.1): it rejects other keys, values
  outside the schema bounds and any body that is not
  `application/json`, so a cross-site HTML form cannot post to it. On
  servers without `router.access` every route falls back to admin-only.
  The plugin adds no auth of its own.
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
  n2k.ts              NMEA 2000 AIS PGN field mapping
  n2k-lookups.ts      canboat lookup names to AIS codes
  classify.ts         class and type group
  ownposition.ts      own position and staleness
  aggregate.ts        counters, buckets, sectors, vessel registry
  health.ts           duplicate detector and implausible jump tracker
  coverage.ts         H3 cells, daily files, area, GeoJSON
  longrange.ts        daily log of the farthest receptions and fastest senders
  publish.ts          SignalK deltas
  history.ts          HistoryReader interface and History API implementation
  query.ts            windowed queries
  api.ts              REST routes
  export.ts           CSV and GeoJSON serializers for the downloads
  overlay.ts          plotterExtensions provider, manifest and sector wedges
  style.ts            coverage and sector colours shared by overlay and web app
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
