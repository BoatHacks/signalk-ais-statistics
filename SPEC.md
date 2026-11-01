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
  window, except sparse cells farther than the window's
  `coverageDistancePercentile` of distances (default p99, 100 disables): a
  cell beyond that cap stays when it has at least 3 reports, because
  repeated far reports are real reception, while a bogus position is almost
  always a single report. Distance statistics themselves stay unfiltered;
  only coverage is capped, so bogus positions cannot inflate the footprint
  or the overlay. The web map can show the left-out cells too (7).
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
sectors view shows, per sector, the highest hourly p99 in the window (a
conservative figure, since percentiles do not merge exactly from hourly
values), counting only hours with at least 20 reports in that sector. The
sector's report count still includes every hour.

Each hour bucket also keeps the farthest reception per sector and class and
when it arrived. The sectors view draws it as a thin tick beyond the sector's
wedge (from the centre when the sector has no radius), so rare far
receptions such as sporadic E or tropospheric ducting stay visible without
moving the radius. The maximum is untrusted like every maximum (2.3).

### 2.7 Long-range log

The farthest receptions are kept with what history cannot carry: when,
from whom and from where. Per UTC day the plugin keeps the farthest
position report of each MMSI, up to the 50 farthest vessels of the day.
An entry holds the reception time, MMSI, vessel name when known (from
message 5, 19 or 24 part A, or the matching NMEA 2000 PGNs, filled in
later that day if it arrives after the position), class, ship type,
distance, bearing, the reported position and the own position at
reception. Entries are not judged: a far one can be real propagation or a
wrong position sent by the vessel, and the log is there to tell them apart.

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
- The current UTC day's long-range log (2.7), flushed hourly to its file.

History is not kept by the plugin. See section 8.

## 5. Sources / Inputs

1. **AIS messages** from the SignalK server's events, by default
   `nmea0183` (raw NMEA 0183 input, `!AIVDM`) and `N2KAnalyzerOut` (NMEA
   2000 input, each PGN as the server's canboatjs decodes it). The events
   are configurable (9); events carrying raw sentences, such as
   `nmea0183AISout` from converter plugins like
   `signalk-n2kais-to-nmea0183`, work too. Each event has its own decoder
   so multipart messages from different events never mix.
   If the same receiver reaches two events, its messages count twice, so
   the user lists only one of them (see 12). The only source of message counts, message types and class,
   because SignalK's data model does not retain per-message information.
   `!AIVDO` and NMEA 2000 AIS PGNs marked as own transmissions (the
   vessel's own transponder) are excluded from reception statistics.
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
| `GET /sectors?window=24h&class=a\|b\|all` | 24 sectors with count and p99 distance (the highest hourly p99 in the window, see 2.6), and the farthest reception `maxM` with its time: `maxAt` when known exactly, otherwise `maxHour`, the start of the hour it fell in |
| `GET /coverage?window=7d&all=false` | cell ids, GeoJSON for the map, covered area in m²; windows `24h` (today) and `7d`; `all=true` adds the cells beyond the distance cap, marked `capped` |
| `GET /longrange?window=24h` | the 25 farthest entries of the long-range log (2.7) in the window, farthest first; windows `24h` and `7d` |
| `GET /overlay/coverage.geojson` | the plotter overlay's GeoJSON: the 7 day footprint and the 24 hour sector wedges of class A and B |
| `GET /status` | live state: tracked targets, own position age, history reachable or not |

Windows accept `1h`, `24h` and `7d`. Responses are JSON in SI units
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
at each publish interval (`publishIntervalMinutes`, default 5), whether or
not it changed, except the per-sector counters, p99 and maximum distances,
which are published once an hour and on stop: the sectors keep the highest
hourly p99 and the maximum per sector, so finer updates add nothing. History therefore holds the
sectors' closed hours, and the open hour comes from the live state. A gauge with no data (for example
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
- `sectors.<nnn>.<class>.max` in metres, the farthest reception in the
  last hour (untrusted, 2.3)
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
query `max` for each counter: when a bucket's `last` dropped, or its `max`
is above its `last` (a restart that climbed back to the previous value or
higher), its increment is the rise from the previous bucket up to that
`max`, plus the new `last`.
On the provider checked, a restart shows as a plain drop with no `null` or
gap, and buckets start at the query's `from`, so series requests start on
a whole multiple of their resolution. A `last` query returns `null`
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
  the report count), plus the 24 hour sectors of class A and B as wedges
  from the last known own position (`kind: "sector"`), and a line per
  sector along its centre bearing from the wedge out to the farthest
  reception (`kind: "sector-max"`, with `maxM` and its time). Each sector
  feature carries its class in `cls` (`a` or `b`). A fill layer colours
  cells by `intensity` on a magenta to purple ramp, which contrasts with
  chart water and land, a line layer outlines each cell in the same ramp,
  another line layer outlines the sectors, teal for class A and orange for
  class B as on the web app's sectors page, and a thin one draws the
  maxima in the same class colours.
- Live updates need a context that calls `overlay.refresh`, so the manifest
  also declares an optional `background.iframe` page,
  `/signalk-ais-statistics/plotterext/refresh.html` (part of the web app
  bundle), that does so hourly. Without it the overlay still shows, and
  refreshes when the plotter reloads it.
- On the test server the GeoJSON for a few hours of traffic was about 8 KB
  (12 cells, 15 sector wedges), and all overlay routes answered without
  authentication on a server that allows read-only access.
- The overlay is a plotter feature, so it works wherever the plotter
  supports Plotter Extensions; other plotters (for example OpenCPN) are not
  covered.

## 7. User Interface

A SignalK web app, listed in the admin UI, with:

- Overview: type group counts, class A/B split, rates, distance p95 and p99.
- Charts: positions and messages per hour split by class, distance avg,
  p95 and p99 per hour (max shown separately and marked untrusted).
- Sectors: the 24-sector bearing view for class A and B (`#/sectors`), with a thin tick
  per sector out to its farthest reception (hover shows distance and time;
  a tick beyond the scale stops at the rim and is dashed), and below it a
  table of the farthest receptions from the long-range log (2.7): time,
  distance, bearing, class, vessel name and MMSI, its position and the own
  position.
- Map: the coverage footprint with a window selector (day, 7 days), the 24 hour sector wedges and maxima of class A and B from the plotter overlay, in the class colours of the sectors view, on-screen
  toggles that show or hide the cells, the sparse cells beyond the distance cap
  (`All cells`, off by default, drawn dashed) and the class A and B
  sectors (`Sectors A`, `Sectors B`, remembered per browser), and an on-screen basemap switch between OpenStreetMap with
  OpenSeaMap overlay, and the SignalK server's chart provider. Default:
  OSM/OpenSeaMap when the internet is available and the connection is not
  metered, read from `network.internet.state` (`online`, `offline` or
  `metered`) published by the `@meri-imperiumi/signalk-internet` plugin when
  it is installed; the SignalK chart provider, whose tile layers the app
  discovers from the resources API `charts` collection, when offline, when
  the connection is metered, or when the user picks it. A manual choice overrides the default and is
  remembered per browser. If no internet-status plugin is present, the app
  treats the connection as unmetered only when the browser reports it online
  and the user has not chosen otherwise. When the server has no charts, the
  server charts button is greyed out with a short note under it and the map
  uses OSM/OpenSeaMap, since the chart basemap would stay blank.

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
  path (6.2); that is why the sector and histogram bins are published.
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
  `coverageRetentionDays` (default 14; the 7 day map window and the
  overlay need at least 7). Per cell it holds the shortest
  distance seen and the report count; it also holds that day's distance
  histogram, so a window's coverage cap is computed from the files alone. A
  day holds at most 20000 cells. Files are written atomically every hour,
  at the UTC day change and on stop, and today's file is merged back in on
  start.
- The long-range log (2.7) is kept the same way, one file per UTC day,
  `longrange-YYYY-MM-DD.json`, at most 50 entries (about 15 KB), written
  hourly, at the day change and on stop, loaded back on start and pruned
  with the cell files. Everything else is stateless across restarts; the
  last counter values are published once more on stop.

## 9. Configuration

| Option | Default | Notes |
|---|---|---|
| `targetExpirySeconds` | 3600 | live tracking expiry |
| `h3Resolution` | 6 | coverage cell size: 6 is about 7 km across (36 km²); 5 was too coarse (chosen by the maintainer) |
| `coverageDistancePercentile` | 99 | coverage skips cells with fewer than 3 reports beyond this percentile of the window's distances; 100 disables the cap |
| `ownPositionMaxAgeSeconds` | 60 | staleness limit for own position |
| `coverageRetentionDays` | 14 | how long daily cell-set and long-range log files are kept; the map and the overlay show up to 7 days, so two weeks leaves room (chosen by the maintainer) |
| `publishIntervalMinutes` | 5 | how often the statistics paths are published; a divisor of 60; sector paths go out hourly regardless |
| `publishOverlay` | true | register the plotter extension overlay |
| `sentenceEvents` | `nmea0183`, `N2KAnalyzerOut` | server events to read AIS from: raw sentences or canboat PGNs; any event names |

## 10. MVP Scope

### 10.1 MVP Features

- Raw sentence ingestion, class and type group classification.
- Rates and vessel counts per minute and hour.
- Distance statistics (avg, median, p95, p99, max) over all positions, with
  no filtering.
- 24 bearing sectors per class, from per-sector p99.
- Coverage cells and area per day.
- SignalK path publication (6.2).
- Web app with overview, charts, sectors and map (7).
- Overlay resource set for chart plotters (6.3).

### 10.2 Post-MVP / Deferred

- Availability, gaps and last-signal age: not in the MVP; the definition
  needs care (see 1.2) and the data needed for it (gap tracking with an
  injectable clock) is separable.
- Optional rejection of bogus positions (range cap, speed filter) with
  counters: not needed while percentiles carry the distance figures and
  coverage has its own percentile cap.
- Per-MMSI history. The long-range log (2.7) covers the "best catches".

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
  are not. These and the long-range log (2.7), which holds names and
  positions for the same reason, are the only state the plugin owns
  (chosen by the maintainer).
- **Keep everything, report p95 and p99 (chosen by the maintainer, replacing
  an earlier range cap with counters).** Statistics always reflect all
  decoded traffic and nothing is silently discarded. Cost: the max and
  anything derived from it is untrusted. Coverage is the exception and gets
  a configurable percentile cap, because bogus cells would make the overlay
  useless. The cap hides only cells with fewer than 3 reports (chosen by the
  maintainer): on a test receiver nearly all capped cells were the real
  edge of reception, with hundreds of reports between them, and only a few
  single-report cells were bogus.
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
- **Sectors keep the highest hourly p99 per sector, from hours with at
  least 20 reports in the sector (chosen by the maintainer).** In a
  sector-hour with few reports, p99 lands at the top of its distance bin,
  so sparse hours set the radius by chance and every window showed the
  same few bin edges. Skipping them keeps the simple, conservative "best
  hour" reading, over a median of hourly p99s, a lower percentile, or 768
  per-sector bin counters. A sector with no hour of 20 reports shows its
  count but no radius.
- **Far receptions as a tick and a log, not in the radius (chosen by the
  maintainer).** The 20 report minimum keeps rare far receptions out of
  the radius, but they can be real propagation worth seeing. The sectors
  view draws the sector maximum as a thin tick with its time on hover, and the
  long-range log keeps who sent each far position and where both stations
  were, which history cannot store. Cost: 48 more hourly paths and a small
  daily file. Rejected: publishing the time of the maximum as a path (an
  epoch is awkward in history) and one log entry per sector-hour (about
  1,100 a day for times the per-vessel log usually has).
- **Lean history by default (chosen by the maintainer).** The plugin
  publishes every 5 minutes, sends the sector paths once an hour, offers
  windows up to 7 days and keeps coverage files for 14 days. Per-minute
  publishing of all 136 paths wrote about 62,700 rows a day on the test
  server, half of them sector values that change at most hourly; the
  defaults cut that by more than half. History requests run one at a time
  and REST answers are cached for a minute, because parallel requests made
  a busy server's QuestDB exceed its memory limit (each requested path is
  one database query there). Cost: history charts are no finer than the
  publish interval.
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
- **Configurable events (chosen by the maintainer).** Some setups carry AIS
  on other events, so the events are an option defaulting to `nmea0183` and
  `N2KAnalyzerOut`. Cost: a receiver that reaches two listed events is
  counted twice; the option's description says so.
- **NMEA 2000 AIS from `N2KAnalyzerOut`, not through a converter.** The
  server already decodes every PGN with canboatjs and emits the result on
  `N2KAnalyzerOut`, so reading AIS PGNs there needs no second decoder, only
  a field mapping; it spares users the `signalk-n2kais-to-nmea0183` round
  trip. Lookup fields arrive as canboat names and are turned back into AIS
  codes with a local copy of the canboat lookup tables n2k-signalk uses
  (`src/n2k-lookups.ts`); a test checks the copy against `@canboat/ts-pgns`,
  which is only a development dependency so the 6.5 MB package does not
  ship. MMSIs are padded to nine digits, as ITU-R M.585 defines them and as
  the sentence decoder writes them, so a coast station (`00MIDxxxx`) keys
  the same from either input.

- **The bearing view is called "sectors", not "radar" (chosen by the
  maintainer).** "Radar" invited confusion with a real radar overlay on
  the plotter. The view, its route, the overlay layers and feature kinds
  use "sectors". The old `GET /radar` and `#/radar` are gone rather than
  kept as aliases, so no compatibility code is carried into 1.0.0. On the map and in the plotter the sectors are drawn per
  class, in the same colours as the sectors view.

## 13. Open Questions

Checked on 2026-10-30 against a test server (SignalK server 2.35.1) with
the plugin installed. Resolved findings are recorded in 4.1, 6.1, 6.2, 6.3
5, 8 and 12 and in ARCHITECTURE.md; the points below are what is still
unverified.

1. **Overlay smoothness in Freeboard-SK.** The overlay is served and
   small, but nobody has yet looked at it in the plotter, and how large a
   GeoJSON source it handles smoothly (hundreds of cells over 7 days) is
   untested. Whether the class A teal and class B orange sector outlines
   read well on chart water and land there is also unchecked.
