# signalk-ais-statistics Specification

Status: draft 4, implemented by the MVP code. Revised after the scoping answers of 2026-10-30, then
changed to keep all positions and report percentiles instead of rejecting
outliers, then aligned with the MVP implementation. Items still unconfirmed
are in section 13.

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
  sent. Vessels are the senders of class A and class B messages; base
  stations, aids to navigation and SAR aircraft are not counted as vessels.
- Type 9 (SAR aircraft) position reports count as `positions.other`. They
  count toward distance and coverage but have no class, so they are not in
  the per-class sectors.

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
  histogram of distances per bucket (cheap, and mergeable across buckets).
  Bin 0 is [0, 0.5) nm, bins 1 to 30 step by a factor of 2^(1/3) (about
  26 percent) up to 512 nm, and bin 31 holds everything from 512 nm. The
  layout is part of the persistence schema. Percentiles interpolate within
  a bin; the average uses bin centres, with the overflow bin counted as
  512 nm, so live and history-derived figures agree;
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
the p99 distance, per hour bucket, from a coarse per-sector histogram (the
distance bins merged in pairs, 16 bins). The
radar for a longer window shows, per sector, the highest hourly p99 in the
window (a conservative figure, since percentiles do not merge exactly from
hourly values).

## 3. State / Lifecycle Model

No domain lifecycle beyond a per-target tracking record: a target is
"tracked" from its first message until it has been silent for
`targetExpirySeconds` (default 3600), then dropped from live state. No state
diagram is needed.

## 4. Data Model

### 4.1 Published statistics (see 6.2)

History providers do not offer sum or count aggregates (the one checked
accepts only average, min, max, first, last and a few smoothing methods), so
counts are published as cumulative counters and windows are derived by
subtraction.

| Kind | Quantity | Meaning |
|---|---|---|
| counter | messages | all decoded messages since the plugin started |
| counter | positions by class | position reports, class A, class B, other |
| counter | distance bins | position reports per log-spaced distance bin, used to compute window avg, median, p95 and p99 |
| counter | sector counts | position reports per sector and class |
| gauge | distance, rolling 1 h | average, median, p95, p99 and max distance |
| gauge | sector p99, rolling 1 h | p99 distance per sector and class |
| gauge | unique vessels, rolling 1 h and 24 h | total and per type group |
| gauge | coverage | cells and area covered today |

### 4.2 Live state (kept in memory)

- Tracked targets: MMSI, class, type group, last position and its time,
  last seen.
- The open minute and hour buckets.
- The set of cells observed in the current UTC day, flushed hourly to the
  day's cell-set file (section 8).

History is not kept by the plugin. See section 8.

## 5. Sources / Inputs

1. **Raw AIS sentences** from the SignalK server's sentence events
   (`!AIVDM`), by default `nmea0183` (NMEA 0183 input) and `nmea0183AISout`
   (where converter plugins such as `signalk-n2kais-to-nmea0183` emit AIS
   that arrives over NMEA 2000). The events are configurable (9); each has
   its own decoder so multipart messages from different events never mix.
   If the same receiver reaches two events, its messages count twice, so
   the user lists only one of them (see 12). The only source of message counts, message types and class,
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
| `GET /series?metric=&resolution=&from=&to=` | time series for the charts, read from history; `metric` is `messages`, `positions`, `distance` or `vessels`, `resolution` in seconds (at least 60, at most 2000 points) |
| `GET /radar?window=24h&class=a\|b\|all` | 24 sectors with count and p99 distance (the highest hourly p99 in the window, see 2.6) |
| `GET /coverage?window=7d` | cell ids, GeoJSON for the map, covered area in m²; windows `24h` (today), `7d`, `30d` |
| `GET /overlay/coverage.geojson` | the plotter overlay's GeoJSON: the 7 day footprint and the 24 hour radar wedges |
| `GET /status` | live state: tracked targets, own position age, history reachable or not |

Windows accept `1h`, `24h`, `7d`, `30d`. Responses are JSON in SI units
named in the field (`p99M` in metres, `areaM2` in square metres); the web
app converts them to the user's display units (section 7). Responses and say whether they came from history
or from live data (`source`). Unique vessel counts are given for windows up
to 24 hours and are null beyond, since unique counts are not additive.

### 6.2 SignalK paths

The plugin publishes deltas under `sensors.ais.statistics.*` on the own
vessel (source label `signalk-ais-statistics`). History is whatever the
server's history provider records of these, so the paths are part of the
persistence contract (section 8). All published values are numeric, so any
History API provider can store and return them. Every counter is published
every minute, whether or not it changed. A gauge with no data (for example
no position with a known own position in the last hour) is left out of the
delta rather than published as zero or null; the web app's distance series
come from the bin counters, not from these gauges.

Counters (monotonic, count since the plugin started):
- `messages.total`
- `positions.classA`, `positions.classB`, `positions.other`
- `distance.bin.<nn>`, one path per distance bin (32 bins)
- `sectors.<nnn>.<class>.count`, one path per sector and class (48)

Gauges, in SI units like every SignalK path:
- `distance.avg`, `distance.median`, `distance.p95`, `distance.p99`,
  `distance.max` in metres, over the last hour
- `sectors.<nnn>.<class>.p99` in metres, over the last hour
- `vessels.last1h` and `vessels.last24h`, and
  `vessels.byGroup.<group>.last1h` and `.last24h`
- `coverage.area.today` in square metres, and `coverage.cells.today`

On start the plugin suggests default metadata for the distance and area
gauges (`units` `m` or `m2`, and the `distance` display unit category) with
`app.setDefaultMetadata`, so the server's unit preferences apply and a
user's own metadata is never overwritten. Internally distances stay in
nautical miles (the histogram bins in 2.3 are defined in nm) and are
converted at the edges.

Windows longer than 24 hours cannot report unique vessels as one number,
because unique counts are not additive; the web app shows the daily
series instead.

A counter resets to zero when the plugin restarts. Readers detect a value
lower than its predecessor and treat the new value as counted from zero. A
restart inside a bucket would lose the count before it, so readers also
query `max` for each counter: when a bucket's `last` dropped, its increment
is the rise from the previous bucket up to that `max`, plus the new `last`.
On the provider checked, a restart shows as a plain drop with no `null` or
gap, and buckets start at the query's `from`. A `last` query returns `null`
for buckets before the first recorded sample, which readers treat as zero,
and the one provider checked repeats the previous value for buckets with
no new sample. History queries must always pass a `resolution` (without one
the provider returned no rows).

The cell ids themselves are not published, because the History API is built
around numeric values and a provider is not required to store text; see
section 8 for where cell sets live.

### 6.3 Chart plotter overlay

The plugin exposes the reception footprint through the Plotter Extensions
API that Freeboard-SK reads (data overlays need Freeboard-SK 3.4.0 or later), the same
mechanism the `@meri-imperiumi/signalk-internet` plugin uses for its toolbar
button:

- The plugin registers a read-only resource provider for the
  `plotterExtensions` resource type, serving one manifest keyed by the
  plugin id, and only while the plugin is running with `publishOverlay`
  on. The server cannot unregister a provider, so it is registered once and
  answers empty while the plugin is stopped.
- The manifest declares `apiVersion: "1"`, requires `overlays.data`, and
  lists one data overlay (`type: "data"`, band `aboveCharts`) whose `style`
  is an inline MapLibre version 8 style. The style has one GeoJSON source,
  `/plugins/signalk-ais-statistics/overlay/coverage.geojson`, which the
  plotter fetches with the user's credentials: H3 cell polygons for the last
  7 days (`kind: "cell"`, with `id`, a coverage `intensity` from 0 to 1 and
  the report count), plus the 24 hour sector radar as wedges from the last
  known own position (`kind: "radar"`). A fill layer colours cells by
  `intensity` and a line layer outlines the radar.
- Live updates need a context that calls `overlay.refresh`, so the manifest
  also declares an optional `background.iframe` page,
  `/signalk-ais-statistics/plotterext/refresh.html` (part of the web app
  bundle), that does so hourly. Without it the overlay still shows, and
  refreshes when the plotter reloads it.
- On the test server the GeoJSON for a few hours of traffic was about 8 KB
  (12 cells, 15 radar wedges), and all overlay routes answered without
  authentication on a server that allows read-only access.
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
and only when the basemap rules above allow it.

It follows the SignalK plugin UI guideline the maintainer adopted (a dark
"tactical" console look):
- A dark canvas in day and night, with day or night intensity from
  `environment.mode`; flat panels with corner brackets, uppercase labels
  and large monospace values; touch targets of at least 48 px.
- Distances and areas in the user's display units from the path metadata
  (`meta.displayUnits`), otherwise SI with ISO prefixes (`12.3 km`).
- Ship time without a zone suffix when `environment.time.timezoneOffset`
  is published, otherwise UTC with `Z`; dates as `YYYY-MM-DD`.
- Views selected by hash routes (`#/charts?window=7d`); one WebSocket for
  mode, time offset and internet state, throttled to one update per 5 s,
  reconnecting with backoff and showing an offline banner while down.
- The plugin's app icon (`signalk.appIcon`) is also the favicon.

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
  path filters must allow `sensors.ais.statistics.*`.
- Readers may only rely on aggregates every provider is expected to have.
  The provider checked offers `average`, `min`, `max`, `first`, `last`,
  `mid`, `middle_index`, `sma` and `ema`, with no `sum` or `count`. The
  plugin uses `last` and `max` only, which is why counts are published as
  cumulative counters (4.1).
- The one thing the History API cannot carry is the set of covered H3
  cells. The plugin therefore writes one small cell-set file per UTC day in
  its own data directory (a few KB), `coverage-YYYY-MM-DD.json`, pruned by
  `coverageRetentionDays` (default 90). Per cell it holds the shortest
  distance seen and the report count; it also holds that day's distance
  histogram, so a window's coverage cap is computed from the files alone. A
  day holds at most 20000 cells. Files are written atomically every hour,
  at the UTC day change and on stop, and today's file is merged back in on
  start. Everything else is stateless across restarts; the last counter
  values are published once more on stop.

## 9. Configuration

| Option | Default | Notes |
|---|---|---|
| `targetExpirySeconds` | 3600 | live tracking expiry |
| `h3Resolution` | 6 | coverage cell size: 6 is about 7 km across (36 km²); 5 was too coarse (chosen by the maintainer) |
| `coverageDistancePercentile` | 99 | coverage skips cells beyond this percentile of the window's distances; 100 disables the cap |
| `ownPositionMaxAgeSeconds` | 60 | staleness limit for own position |
| `coverageRetentionDays` | 90 | how long daily cell-set files are kept |
| `publishOverlay` | true | register the plotter extension overlay |
| `sentenceEvents` | `nmea0183`, `nmea0183AISout` | server events to read raw sentences from; any event names |

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
  are not. This is the only state the plugin owns (chosen by the maintainer).
- **Keep everything, report p95 and p99 (chosen by the maintainer, replacing
  an earlier range cap with counters).** Statistics always reflect all
  decoded traffic and nothing is silently discarded. Cost: the max and
  anything derived from it is untrusted. Coverage is the exception and gets
  a configurable percentile cap, because bogus cells would make the overlay
  useless.
- **Counts as cumulative counters (chosen by the maintainer).** History
  providers lack sum and count aggregates; a window total is `last(end)`
  minus `last(start)`, and counter resets are detected by the reader with the
help of `max` (6.2). Verified across a plugin restart on the test server.
- **Published under `sensors.ais.statistics.*` (chosen by the maintainer).**
  It sits next to `sensors.ais.class`. The SignalK schema defines a sensor
  as an object with `name`, `sensorType`, `sensorData`, `fromBow`,
  `fromCenter` and `class` and does not forbid other keys, so `statistics`
  does not conflict with any defined key; another plugin already publishes
  `sensors.ais.status` as a precedent.
- **Publish distance histogram bins as paths (chosen by the maintainer).**
  About 30 extra paths per hour, in exchange for exact window percentiles
  from merged history.
- **Read-only users may use the web app (chosen by the maintainer).** Needs
  explicit route permissions, since SignalK defaults plugin routes to
  admin-only.
- **Radar keeps the highest hourly p99 per sector (chosen by the
  maintainer).** In a sector-hour with fewer than about 100 reports, p99 is
  close to that hour's maximum, so one bogus position can set a sector's
  radius for a whole window. Accepted for its simplicity and conservative
  reading, over a minimum report count per hour, a lower percentile, or 768
  per-sector bin counters.
- **Bucket-based statistics, not rolling all-time figures.** Conditions
  such as ducting change daily; one all-time max would hide that.
- **Availability deferred.** Its definition needs care (window, gap
  threshold, time the plugin was down), and the MVP is more useful with
  range and coverage first.

- **SI units on paths and in the REST API (chosen by the maintainer).**
  SignalK paths carry SI values and display units come from path metadata,
  so distances are published and served in metres and areas in square
  metres, replacing earlier `...Nm` and `...Km2` names. Nothing was
  released, so no stored history needed migrating.
- **Configurable sentence events (chosen by the maintainer).** AIS from an
  NMEA 2000 receiver reaches plugins only through a converter on
  `nmea0183AISout`, and some setups use other events, so the events are an
  option defaulting to `nmea0183` and `nmea0183AISout`. Cost: a receiver
  that reaches two listed events is counted twice; the option's description
  says so. Decoding NMEA 2000 PGNs directly was rejected as a second
  decoder.

## 13. Open Questions

Checked on 2026-10-30 against a test server (SignalK server 2.35.1) with
the plugin installed. Resolved findings are recorded in 4.1, 6.1, 6.2, 6.3
5, 8 and 12 and in ARCHITECTURE.md; the points below are what is still
unverified.

1. **Overlay smoothness in Freeboard-SK.** The overlay is served and
   small, but nobody has yet looked at it in the plotter, and how large a
   GeoJSON source it handles smoothly (hundreds of cells over 30 days) is
   untested.
