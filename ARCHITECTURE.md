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
typed message objects (type, MMSI, class, optional position, optional ship
type). Owns nothing persistent. Per-sentence decode errors are counted and
swallowed, never thrown into the server.

### 2.2 OwnPosition
Tracks the latest self `navigation.position` and its timestamp. Exposes
`at(time)` returning the position or `undefined` when stale
(`ownPositionMaxAgeSeconds`). Pure state, no I/O.

### 2.3 Classifier
Maps message type to class and ship type to type group (SPEC 2.1). Nothing
is filtered (SPEC 2.3). Coverage applies its own percentile cap (see 2.5 below).

### 2.4 Aggregator
Owns the open minute and hour buckets. For each decoded message it updates
counts, a fixed log-spaced distance histogram (average, median, p95, p99 and
max derive from it), a coarse per-sector histogram and vessel sets. On
rollover it hands the closed bucket to the Publisher. Pure and
clock-injectable.

### 2.5 Coverage
Maps each position to an H3 cell (`h3-js`), keeps the cell set for the
current UTC day, flushes it hourly to a daily JSON file in the plugin data
directory, and reports cell counts and area to the Publisher. Applies the
`coverageDistancePercentile` cap (SPEC 2.4) when building a window's
footprint, using the merged distance histogram. Computes
covered area and produces the GeoJSON used by the map and the overlay.

### 2.6 Publisher
Emits the SignalK deltas of SPEC 6.2 through the plugin API's delta handler,
with the plugin id as source. Every value in SPEC 4.1 and 6.2 is published
every minute, counters as running totals since the plugin started and gauges
as rolling one-hour or 24-hour figures, whether or not it changed.

### 2.7 HistoryReader
The only component that reads history. A small interface
(`series(metric, from, to, resolution)`) with an implementation on the
SignalK v2 History API and a null implementation for live-only mode. It
finds the provider through the API's provider listing, uses only features
every provider is expected to have, and never talks to a database directly
(SPEC 8).

### 2.8 Query layer
Combines the live state (current open bucket) with HistoryReader results to
answer windowed queries. All REST handlers go through it. A window total is
`last(end)` minus `last(start)` of a counter, with reset detection (a value
lower than its predecessor starts a new segment counted from zero); window
percentiles come from the difference of the distance bin counters.

### 2.9 REST API
Express router registered through the plugin API. Thin: parse and validate
parameters, call the query layer, serialize (SPEC 6.1).

### 2.10 Overlay provider
Registers a read-only `plotterExtensions` resource provider through
`app.registerResourceProvider`, serving the overlay manifest only while the
plugin runs (the pattern `@meri-imperiumi/signalk-internet` uses). Serves the
MapLibre style and the coverage GeoJSON from `public/plotterext/`, rewritten
hourly from Coverage, and a small background page that calls
`overlay.refresh` through the plotter extension bus (SPEC 6.3).

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
| Language | TypeScript | matches the plugin API types |
| Runtime | Node 22 or newer (the test server runs Node 26) | follow the host |
| Plugin API | `@signalk/server-api` | official types |
| AIS decoding | `ggencoder` ^1.0.8 | already a dependency of the server's `@signalk/nmea0183-signalk` (ggencoder 1.0.13 on the test server, SignalK server 2.35.1), so no new decoder family |
| Geo | own haversine and bearing, `h3-js` for cells | h3-js is pure JS, no native module |
| History | SignalK v2 History API, any provider, read via HistoryReader | chosen by the maintainer; no database dependency |
| Cell sets | JSON files in the plugin data directory | the History API cannot carry id lists |
| Web app | small framework-free or Preact app, Leaflet for the map, a small chart library | bundled locally, phone friendly |
| Tests | Vitest | fast, TypeScript native |

## 5. Integration Points

- **SignalK sentence events**: input for all message statistics, via
  `app.on('nmea0183', handler)`. The handler receives the raw sentence as a
  plain string, with no source or timestamp, so `!AIVDO` is told apart by
  its prefix and reception time is the time of the call.
- **`navigation.position` (self)**: via a stream subscription.
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
- REST routes are all read-only and are registered for read-only users with
  `registerPluginRoutePermissions` (without it the server falls back to
  admin-only). The plugin adds no auth of its own, and exposes no write
  routes.
- History reads are History API requests built from a fixed set of queries
  with validated parameters; no user-supplied paths or SQL.
- Nothing is sent off the boat; the plugin makes no outbound network calls.

## 7. File Structure

```
src/
  index.ts            plugin entry, wiring, lifecycle (start/stop)
  config.ts           schema and defaults
  paths.ts            published path names (the persistence schema)
  ingest.ts           sentence reassembly and decode
  classify.ts         class, type group, rejection rules
  aggregate.ts        buckets, sectors, vessel sets
  coverage.ts         H3 cells, area, GeoJSON
  publish.ts          SignalK deltas
  history.ts          HistoryReader interface and History API implementation
  query.ts            windowed queries
  api.ts              REST routes
  overlay.ts          plotterExtensions provider, style and GeoJSON files
  geo.ts              haversine, bearing, sector
web/                  web app source, built into public/
test/                 unit tests, fixture AIS sentence files
docs/plans/           per-issue implementation plans
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
