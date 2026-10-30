# signalk-ais-statistics Specification

Status: draft 3. Revised after the scoping answers of 2026-10-30, then
changed to keep all positions and report percentiles instead of rejecting
outliers. Items still unconfirmed are in section 13.

## 1. Introduction

### 1.1 Purpose

signalk-ais-statistics is a SignalK server plugin that turns the AIS traffic
the server already receives into reception statistics for the vessel's own
AIS station: how many vessels and messages, from which directions, how far
away, and where reception has actually reached.

Reception statistics (vessels captured, positions and messages per hour,
distance reached, bearing coverage) are useful for tuning an antenna or
receiver, but a SignalK server has no built-in way to produce them locally.
This plugin computes them on the boat, offline, with statistics that stay
trustworthy despite bad positions, shows them in a SignalK web app with
graphs and maps, and publishes the reception footprint as an overlay layer
for chart plotters such as Freeboard-SK.

### 1.2 Background

Practical facts about AIS reception that shape this spec:

- Received positions can be wrong. Bad or spoofed positions imply distances
  of thousands of nautical miles, which VHF cannot reach. A usable distance
  statistic has to be robust to them, which is why this plugin reports
  percentiles instead of trusting the maximum (see 2.3).
- A boat moves, so range and coverage must be measured from the own
  position at the time of reception, not from a fixed point.
- Range varies strongly with conditions: normally about 30 nm for a low
  antenna, but several times that when tropospheric ducting occurs.
  Statistics must therefore be reported per time bucket, not only as one
  all-time figure.
- "Availability" needs an explicit definition (window and gap threshold)
  to be meaningful. It is deferred (10.2) so that when it is added its
  definition is explicit.

The statistics are defined by this plugin (section 2), not by any external
service.

### 1.3 Terminology

- **Own position**: the vessel's `navigation.position` at the time a message
  was received.
- **Target**: another vessel, identified by MMSI, reported via AIS.
- **Class A / Class B**: AIS transponder classes, derived from the message
  type (1, 2, 3 and 5 for A; 18, 19 and 24 for B).
- **Position report**: an AIS message carrying a position (types 1, 2, 3,
  18, 19, and 9 for SAR aircraft).
- **Message**: any decoded AIS sentence, regardless of type.
- **Bucket**: a fixed UTC-aligned time slice (minute or hour) that
  statistics are aggregated into.
- **Sector**: a 15 degree wedge of bearing from own position, numbered
  clockwise from true north (24 sectors).
- **Type group**: one of cargo, tanker, passenger, fishing, pleasure craft,
  other, derived from the AIS ship type code.
- **Cell**: an H3 hexagon used to express coverage.

## 2. Domain Rules

### 2.1 Classification

- Class is derived from the message type, not from a vessel database.
- Type group is derived from the AIS ship type code (message 5/24), using the
  standard ranges: 30 fishing, 36/37 pleasure craft, 60-69 passenger,
  70-79 cargo, 80-89 tanker, everything else other. Targets whose type is
  not yet known are counted as "unknown" for that bucket.
- A target counts once per bucket in "vessels", however many messages it
  sent.

### 2.2 Distance and bearing

- Distance is great-circle distance in nautical miles from own position at
  reception time to the target position.
- Bearing is the initial true bearing from own position to the target.
- If own position is unknown or stale (older than the configured max age),
  the position report still counts toward rates and vessel counts but is
  excluded from distance, sector and coverage statistics.

### 2.3 Bogus positions

No position report is dropped or flagged. Every report with a valid
latitude and longitude counts toward every statistic, so the numbers always
reflect everything the receiver decoded. Reports with latitude or longitude
out of range cannot be used for distance and are skipped for distance only.

Distance statistics are made robust by reporting percentiles instead of
trusting the maximum:

- average, median, p95 and p99 distance, computed from a fixed log-spaced
  histogram of distances per bucket (cheap, and mergeable across buckets);
- the maximum is still reported, labelled as untrusted, because it can be
  wildly wrong (thousands of nm) when a single bad position arrives.

p99 is the recommended "typical best case" figure. A bucket's percentiles
are exact to the histogram bin width; percentiles over a window are
computed by merging the bucket histograms.

### 2.4 Coverage

- Coverage is the set of H3 cells (resolution configurable, default 5,
  edge about 8 km) that contained at least one target position in the
  window, except cells farther than the window's
  `coverageDistancePercentile` of distances (default p99, 100 disables).
  Distance statistics themselves stay unfiltered; only coverage is capped,
  so bogus positions cannot inflate the footprint or the overlay.
- Covered area is the cell count times the mean cell area. This is a
  reception footprint, not a guaranteed range, and depends on where traffic
  was.
- Because the station is mobile, a cell is attributed to the day it was
  observed, and the footprint for a window is the union of its days.

### 2.5 Rates

Messages and position reports per minute and per hour, split by class for
positions, and the count of unique vessels per hour and per type group.

### 2.6 Sectors

For each of 24 sectors and for each class: number of position reports and
the p99 distance, per hour bucket, from a coarse per-sector histogram. The
radar for a longer window shows, per sector, the highest hourly p99 in the
window (a conservative figure, since percentiles do not merge exactly from
hourly values).

## 3. State / Lifecycle Model

No domain lifecycle beyond a per-target tracking record: a target is
"tracked" from its first message until it has been silent for
`targetExpirySeconds` (default 3600), then dropped from live state. No state
diagram is needed.

## 4. Data Model

### 4.1 Hour summary (what gets published, see 6.2)

| Field | Meaning |
|---|---|
| `start` | UTC hour start |
| `messages` | all decoded messages |
| `positions.a`, `positions.b`, `positions.other` | position reports by class |
| `vessels.total`, `vessels.byGroup` | unique MMSIs in the hour |
| `distance.avgNm`, `.medianNm`, `.p95Nm`, `.p99Nm`, `.maxNm` | over all reports with a usable position |
| `distance.histogram` | counts per log-spaced bin, used to merge windows |
| `sectors[24].a`, `.b` | count and p99 distance per class |

### 4.2 Live state (kept in memory)

- Tracked targets: MMSI, class, type group, last position and its time,
  last seen.
- The open minute and hour buckets.
- The set of cells observed in the current UTC day, flushed hourly to the
  day's cell-set file (section 8).

History is not kept by the plugin. See section 8.

## 5. Sources / Inputs

1. **Raw AIS sentences** from the SignalK server's sentence events
   (`!AIVDM`). The only source of message counts, message types and class,
   because SignalK's data model does not retain per-message information.
   `!AIVDO` (the vessel's own transponder) is excluded from reception
   statistics.
2. **Own position** from `navigation.position` on self.
3. **History** from whichever history provider the server has registered,
   read through the SignalK v2 History API, for the web app and for windowed
   queries (see 8).

If own position is missing, distance and coverage degrade as in 2.2. If no
sentences arrive, the plugin reports "no data", not zeros.

## 6. API Specification

### 6.1 REST API (backend of the web app)

All routes are mounted under `/plugins/signalk-ais-statistics/`. SignalK
treats any plugin route as admin-only unless the plugin registers
permissions for it. On server 2.35.1 the plugin router has
`router.access('readonly')`, which does that registration; the plugin
registers every route through it, guarded by `router.access ?` so older
servers fall back to admin-only instead of failing. All routes are read-only
and no write routes exist. Read-only users can therefore open the web app,
including when it is embedded in another page such as an infodisplay panel.

| Route | Returns |
|---|---|
| `GET /summary?window=24h` | headline figures: messages, positions, vessels by group, distance avg, p95, p99 and max |
| `GET /series?metric=&resolution=&from=&to=` | time series for the charts, read from history |
| `GET /radar?window=24h&class=a\|b\|all` | 24 sectors with count and max distance |
| `GET /coverage?window=7d` | cell ids, GeoJSON for the map, covered area in km2 |
| `GET /status` | live state: tracked targets, own position age, history reachable or not |

Windows accept `1h`, `24h`, `7d`, `30d`. Responses are JSON with explicit
units (`nm`, `km2`) in field names.

### 6.2 SignalK paths

The plugin publishes deltas under `plugins.aisStatistics.*` (source label
`signalk-ais-statistics`). History is whatever the server's history provider
records of these, so the paths are part of the persistence contract
(section 8). All published values are numeric, so any History API provider
can store and return them.

- Every minute: `messagesPerMinute`, `positionsPerMinute.classA`, `.classB`
- Every minute: `vessels.last1h`, `distance.avgNm.last1h`,
  `distance.p95Nm.last1h`, `distance.p99Nm.last1h`, `distance.maxNm.last1h`
- Every hour for the closed hour: `vessels.byGroup.<group>`,
  `distance.histogram.<bin>` (one path per bin, so windows can be merged
  from history), `sectors.<nnn>.<class>.count`,
  `sectors.<nnn>.<class>.p99Nm`
- Hourly: `coverage.areaKm2.today` and `coverage.cells.today` (counts).
  The cell ids themselves are not published, because the History API is
  built around numeric values and a provider is not required to store text;
  see section 8 for where cell sets live.

(Final path naming is subject to a check against SignalK conventions; 13.)

### 6.3 Chart plotter overlay

The plugin exposes the reception footprint through the Plotter Extensions
API that Freeboard-SK (3.3.0 at the time of writing) reads, the same
mechanism the `@meri-imperiumi/signalk-internet` plugin uses for its toolbar
button:

- The plugin registers a read-only resource provider for the
  `plotterExtensions` resource type, serving one manifest keyed by the
  plugin id, and only while the plugin is running.
- The manifest declares `apiVersion: "1"`, requires `overlays.data`, and
  lists one data overlay (`type: "data"`, band `aboveCharts`) whose `style`
  is a MapLibre style served by the plugin. The style has a GeoJSON source
  (H3 cell polygons, one feature per cell with an `id` and a coverage
  `intensity` property, plus the sector radar as polygons) and a fill layer
  coloured by `intensity`.
- Live updates need a context that calls `overlay.refresh`, so the manifest
  also declares an optional `background.iframe` page that does so hourly.
  Without it the overlay still shows, and refreshes when the plotter
  reloads it.
- The overlay is a plotter feature, so it works wherever the plotter
  supports Plotter Extensions; other plotters (for example OpenCPN) are not
  covered.

## 7. User Interface

A SignalK web app, listed in the admin UI, with:

- Overview: type group counts, class A/B split, rates, distance p95 and p99.
- Charts: positions and messages per hour split by class, distance avg,
  p95 and p99 per hour (max shown separately and marked untrusted).
- Radar: the 24-sector bearing view for class A and B.
- Map: the coverage footprint with a window selector (day, 7 days, 30
  days) and an on-screen basemap switch between OpenStreetMap with
  OpenSeaMap overlay, and the SignalK server's chart provider. Default:
  OSM/OpenSeaMap when the internet is available and the connection is not
  metered, read from `network.internet.state` (`online`, `offline` or
  `metered`) published by the `@meri-imperiumi/signalk-internet` plugin when
  it is installed; the SignalK chart provider, whose tile layers the app
  discovers from the resources API `charts` collection, when offline, when
  the connection is metered, or when the user picks it. A manual choice overrides the default and is
  remembered per browser. If no internet-status plugin is present, the app
  treats the connection as unmetered only when the browser reports it online
  and the user has not chosen otherwise.

It must work on a phone, since the boat server is often viewed remotely
over a metered link, so the app's own assets are bundled locally (no CDN)
and payloads stay small; only the optional OSM tiles come from the internet,
and only when the basemap rules above allow it. It follows the SignalK
admin UI look.

## 8. Persistence

The plugin keeps no time series of its own. Whatever history provider the
server has registered records the published paths, and the plugin reads them
back through the SignalK v2 History API. It does not depend on a particular
provider (QuestDB, InfluxDB or any other) and never talks to a database
directly. Consequences:

- Anything the web app must show over time has to be published as a numeric
  path (6.2); that is why the radar and histogram bins are published.
- If no history provider is registered, or it does not answer, the plugin
  runs in live-only mode: deltas are still published, the web app shows the
  current window it holds in memory, and `/status` says history is
  unavailable. The plugin discovers providers through the History API's
  provider listing and uses the server's default provider.
- Retention is the provider's setting, not a plugin option.
- Providers differ in sampling and in whether they re-record unchanged
  values, so the plugin publishes every value at its interval and readers
  must treat a missing sample as "unchanged", not as a gap. The provider's
  path filters must allow `plugins.aisStatistics.*`.
- The one thing the History API cannot carry is the set of covered H3
  cells. The plugin therefore writes one small cell-set file per UTC day in
  its own data directory (a few KB), pruned by `coverageRetentionDays`
  (default 90). Everything else is stateless across restarts, apart from the
  open bucket at shutdown, which is flushed on stop.

## 9. Configuration

| Option | Default | Notes |
|---|---|---|
| `targetExpirySeconds` | 3600 | live tracking expiry |
| `h3Resolution` | 5 | coverage cell size |
| `coverageDistancePercentile` | 99 | coverage skips cells beyond this percentile of the window's distances; 100 disables the cap |
| `ownPositionMaxAgeSeconds` | 60 | staleness limit for own position |
| `coverageRetentionDays` | 90 | how long daily cell-set files are kept |
| `publishOverlay` | true | register the plotter extension overlay |

## 10. MVP Scope

### 10.1 MVP Features

- Raw sentence ingestion, class and type group classification.
- Rates and vessel counts per minute and hour.
- Distance statistics (avg, median, p95, p99, max) over all positions, with
  no filtering.
- 24 sector radar per class, from per-sector p99.
- Coverage cells and area per day.
- SignalK path publication (6.2).
- Web app with overview, charts, radar and map (7).
- Overlay resource set for chart plotters (6.3).

### 10.2 Post-MVP / Deferred

- Availability, gaps and last-signal age: not in the MVP; the definition
  needs care (see 1.2) and the data needed for it (gap tracking with an
  injectable clock) is separable.
- Optional rejection of bogus positions (range cap, speed filter) with
  counters: not needed while percentiles carry the distance figures and
  coverage has its own percentile cap.
- Per-MMSI history and a "best catches" list.

## 11. References

- ITU-R M.1371 for AIS message types and ship type codes (verify clause
  numbers against the current edition before relying on them).
- SignalK data model, plugin API (`@signalk/server-api`) and resources API.
- H3 hexagonal grid (`h3-js`).

## 12. Design Decisions

- **Compute from raw sentences, not the SignalK vessel tree.** The tree has
  no per-message information, and class and message type are needed for the
  class split and message statistics. Cost: decoding AIS in the plugin.
- **History through the SignalK History API, any provider (chosen by the
  maintainer; first QuestDB specifically, then generalized).** Avoids a
  second store and a hard dependency on one database. Cost: everything shown
  over time must be published as a numeric path first, and behavior depends
  on what the provider supports. Live-only mode keeps the plugin
  functional without a provider.
- **Covered cells stored in a small plugin file, not in history.** A
  consequence of the above: the History API is numeric, and cell id lists
  are not. This is the only state the plugin owns (proposed, not yet
  confirmed with the maintainer; see 13.2).
- **Keep everything, report p95 and p99 (chosen by the maintainer, replacing
  an earlier range cap with counters).** Statistics always reflect all
  decoded traffic and nothing is silently discarded. Cost: the max and
  anything derived from it is untrusted. Coverage is the exception and gets
  a configurable percentile cap, because bogus cells would make the overlay
  useless.
- **Publish distance histogram bins as paths (chosen by the maintainer).**
  About 30 extra paths per hour, in exchange for exact window percentiles
  from merged history.
- **Read-only users may use the web app (chosen by the maintainer).** Needs
  explicit route permissions, since SignalK defaults plugin routes to
  admin-only.
- **Bucket-based statistics, not rolling all-time figures.** Conditions
  such as ducting change daily; one all-time max would hide that.
- **Availability deferred.** Its definition needs care (window, gap
  threshold, time the plugin was down), and the MVP is more useful with
  range and coverage first.

## 13. Open Questions

Checked on 2026-10-30 against a test server (SignalK server 2.35.1) and the Freeboard-SK
plotter extensions documentation; the points below are what is still
unverified. Resolved findings are recorded in 6.1, 6.3 and 8 and in
ARCHITECTURE.md.

1. **History API use.** `values` queries have not been exercised against a
   live server (`signalk-questdb` 2.3.2 was the provider on the test server, but any
   provider should work), and it is not checked whether a default provider
   is selected (`historyApi.defaultProvider`). Confirm that aggregate queries
   over `plugins.aisStatistics.*` return what section 8 assumes, and which
   aggregates are guaranteed across providers.
2. **Cell sets in a plugin file.** Section 8 adds a small data-directory
   file for covered cells because the History API is numeric. Confirm this is
   acceptable, or choose between dropping coverage history beyond one day or
   encoding cells as numeric paths (far more paths than the 30 per hour for
   histogram bins).
3. **Plotter extension data overlay.** The Freeboard-SK doc describes
   `overlay.setData` and `overlay.refresh` but not a server-only way to push
   live data, so the background iframe page is needed for live refresh. How
   large a GeoJSON source the plotter handles smoothly (hundreds of cells
   over 30 days) is untested.
4. **Raw sentence event payload.** Existing plugins listen with
   `app.on('nmea0183', handler)`, which is the event the plugin should use.
   The payload shape (sentence string versus object with source
   information) and `!AIVDO` handling have not been inspected.
5. **Path naming** under `plugins.*` against SignalK conventions for derived
   data.
