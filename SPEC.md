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
The message health counters (2.8) count such reports and implausible
position jumps, but only count: nothing they find is removed from any
other statistic.

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

- Coverage is the set of H3 cells (resolution configurable, default 6,
  about 7 km across) that contained at least one target position in the
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
- Each report's cell is also filed under the own vessel mode at reception
  (2.9): stationary, underway or unknown. The footprint of one mode holds
  only its cells; the combined footprint holds all three. Every footprint
  is capped with the distances of all modes together, so a mode's
  footprint is always a subset of the combined one. Nothing is left out
  for its mode: a report received before the mode is known counts under
  unknown, which only the combined footprint shows. Only coverage is split;
  distances, sectors, counts and the published paths stay combined.

### 2.5 Rates

Messages and position reports per minute and per hour, split by class for
positions, and the count of unique vessels per hour and per type group.

### 2.6 Sectors

For each of 24 sectors and for each class: number of position reports and
the p99 distance, per hour bucket, from a coarse per-sector histogram (the
distance bins merged in pairs, 16 bins), capped at the farthest reception
in that sector and hour, since interpolation within a coarse bin can land
beyond it. The
sectors view shows, per sector, the highest hourly p99 in the window (a
conservative figure, since percentiles do not merge exactly from hourly
values), counting only hours with at least 20 reports in that sector. The
sector's report count still includes every hour.

Each hour bucket also keeps the farthest reception per sector and class and
when it arrived. The sectors view outlines the sector holding the chart's
farthest reception bolder and puts one small dot on its centre line at
that distance; hovering any wedge shows its own farthest reception and
time (chosen by the maintainer, replacing a tick per sector). So rare far receptions such as sporadic E or
tropospheric ducting stay visible without moving the radius. The maximum is untrusted like every maximum (2.3).

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
The same daily file keeps the fastest senders of the day (2.8).

### 2.8 Message health

What the receiver decodes is judged as well as counted. Each finding is a
cumulative counter (6.2), and none removes a message from any other
statistic (2.3):

- **Decode errors and incomplete messages**: sentences or PGNs that could
  not be decoded, and multipart messages dropped because a part never
  arrived.
- **Duplicates**: a message with the same MMSI and message type (and part,
  for message 24) and a position within 2e-5 degrees, about 2 m, or no
  position on either, received less than 2 s after the first copy. The
  window is fixed. The key does not depend on the decoder, so a sentence
  and a PGN carrying the same message match. One detector serves all
  configured events and counts two kinds: same-event duplicates (a
  receiver repeating itself, or two receivers on one event) and
  cross-event duplicates (the same message on two configured events, the
  likely cause being one receiver reaching both).
- **Invalid positions**: position reports whose position was out of range
  or "not available" (91, 181).
- **No own position**: position reports with a usable position received
  while the own position was unknown or stale (2.2), which explains a gap
  in the distance figures.
- **Implausible jumps**: per sender the plugin keeps an anchor position.
  When a position report lies at least 500 m from the anchor and at least
  1 s later, distance over time is the implied speed, and the report
  becomes the anchor; a report closer than 500 m replaces an anchor older
  than 60 s. So GPS jitter never counts, a fast craft reporting every 2 s
  is still measured, and a bogus position is judged against a position at
  most a minute or one reporting interval old. A speed above the sender's
  limit is a jump. One bogus position counts as two jumps, out and back.
  Limits are settings (9): 60 kn by default, 120 kn for ship types 20 to
  29 (wing in ground) and 40 to 49 (high-speed craft such as hovercraft
  ferries), 600 kn for message 9 (SAR aircraft). A sender whose ship type
  is not yet known is judged by the ordinary limit, so a high-speed craft
  can count a few jumps before its message 5 or 24 is heard.

Shares over a window divide a counter by everything received: decoded
messages plus decode errors and incomplete messages. The good share leaves
out decode errors, incomplete messages, duplicates and invalid positions;
jumps and reports without an own position are no fault of the message.
The web app hints at a misconfiguration when duplicates exceed 20 percent
of the decoded messages (fixed, no notification). Same-event duplicates
always count toward the hint; cross-event duplicates count too while
per-source statistics are off, and are shown as receiver overlap once
they exist.

**Fastest vessels.** Per UTC day the plugin keeps the highest implied
speed of each sender in two lists of up to 10 in the long-range file (2.7,
8): plausible speeds, and implausible jumps (above the sender's limit). Kept
apart, a day of bogus positions cannot push real fast craft out (chosen by
the maintainer); one sender can appear in both.
An entry holds the time, MMSI, name when known, class, ship type, the
implied speed, the speed over ground reported with the later position (both
decoders deliver it; the "not available" value is left out), the limit
that applied, whether the speed is above it, the time between the two
positions and both positions. Both lists are ranked by implied speed
(chosen by the maintainer), so a bogus jump can be told from a fast craft
side by side.

### 2.9 Stationary and underway

The own vessel is stationary, underway or unknown (#17). The mode decides
only which coverage cells a report is filed under (2.4) and, for #13,
whether alerts are suppressed while underway.

- `navigation.state` on self decides whenever its last value is
  recognised, even if it may be stale (a state left at `moored` after
  casting off still counts as stationary; chosen by the maintainer).
  Stationary: `anchored`, `moored`, `not-under-way`, `aground`. Underway:
  `sailing`, `motoring`, `towing ...`, `pushing`, `fishing ...`,
  `trawling ...`, `pilotage`, `restricted manouverability ...`,
  `constrained by draft`, `mine clearance`. Case, hyphens and underscores
  do not matter, and "manoeuvrability" and "maneuverability" are accepted
  next to the schema's spelling. Every other value (`default`,
  `not under command`, the reserved values, null) hands over to drift.
- Drift, when no recognised state is set: own positions are sampled at
  most every 10 s (at most 60 samples per window). Once the samples span
  `modeDriftMinutes` (default 10) and all lie within
  `modeDriftRadiusMeters` (default 200, allowing for an anchor swing) of
  their mean, the vessel is stationary and the mean is its spot; as soon
  as a position lies beyond the radius from the spot, it is underway and
  the window starts again. A full window with a wider spread is underway.
  After a start, or a gap in own positions longer than
  `ownPositionMaxAgeSeconds`, drift is unknown until the window has
  filled again.
- The mode is decided at reception and never revised: a vessel that has
  just stopped counts as underway for the first `modeDriftMinutes`.
### 2.10 Propagation alerts

With `propagationAlerts` on (off by default, chosen by the maintainer),
the plugin raises a SignalK notification while reception range is well
above normal, as in a tropospheric ducting or sporadic E opening, so the
crew can watch it live instead of finding it in the long-range log (2.7)
the next day.

- **Normal range**: the median of the hourly p99 distance over the last 7
  days, from hours that have ended with at least 20 position reports (the
  sectors' minimum, 2.6), each hour's p99 capped at its farthest
  reception. It is read once an hour, and again when a history provider
  comes or goes, through the same hourly distance series the charts use,
  so it comes from the bin counters with `last` and `max` only; in
  live-only mode it comes from the live hour buckets, at most 24 hours. No
  time-of-day baseline. Alerts are armed once 24 qualifying hours are
  known.
- **Check**: once a minute, over the recent window
  (`propagationWindowMinutes`, default 15): the p99 of the window's minute
  buckets is at least `propagationFactor` (2) times the normal p99, and at
  least `propagationMinVessels` (3) distinct MMSIs were received beyond
  the normal p99 distance, each counted once at its farthest report in the
  window. The maximum is never used, so one bogus position cannot fire the
  alert (2.3).
- **Hysteresis by time** (chosen by the maintainer): the alert fires once
  both conditions have held at every check for
  `propagationSustainMinutes` (15), and clears once they have failed at
  every check for the same time. There is no second threshold.
- **Underway**: with `propagationSuppressUnderway` on (the default), the
  alert is held back while the own vessel is underway (2.9), since range then
  changes with the position anyway. The detector keeps evaluating; the
  state reads `suppressed`, and the notification returns to normal. While
  the mode is unknown nothing is held back.
- **Notification**: `notifications.sensors.ais.statistics.propagation`
  (6.2), state `propagationNotificationState` (`warn`) and methods
  `propagationNotificationMethods` (`visual`). The message names the
  ratio, the recent and normal p99, the vessels beyond normal and their
  sectors. It goes back to `normal` when the alert clears and when the
  plugin stops.
- The detector is a side view of the located reports; nothing is dropped
  from any statistic, and it keeps no state across restarts.

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
| counter | message health | decode errors, incomplete, duplicates (same and cross event), invalid positions, implausible jumps, reports without own position (2.8) |
| counter | per source (opt-in) | messages, positions by class, distance bins and message health per server event (5) |
| gauge | distance, rolling 1 h | average, median, p95, p99 and max distance |
| gauge | sector p99, rolling 1 h | p99 distance per sector and class |
| gauge | unique vessels, rolling 1 h and 24 h | total and per type group |
| gauge | coverage | cells and area covered today |
| gauge | propagation ratio (opt-in) | recent p99 over the normal p99 (2.10) |

### 4.2 Live state (kept in memory)

- Tracked targets: MMSI, class, type group, last position and its time,
  last seen.
- The open minute and hour buckets.
- The set of cells observed in the current UTC day, flushed hourly to the
  day's cell-set file (section 8).
- The current UTC day's long-range log (2.7) and fastest list (2.8),
  flushed hourly to its file.
- The duplicate detector's copies of the last 2 s and the jump tracker's
  anchor per sender (2.8), pruned after `targetExpirySeconds`.
- The own vessel mode (2.9): the last `navigation.state` and at most 60
  own position samples. Lost on restart; drift starts unknown again.
- With propagation alerts on (2.10): the normal range, the farthest report
  per sender and minute in the recent window, the alert state and the last
  60 checks.

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
   the user lists only one of them (see 12). With `sourceStatistics` on
   (9, #14), each event is also counted on its own, to compare antennas or
   receivers: one more aggregator per event sees the messages that event
   delivers, while the main figures stay unchanged and unfiltered (two
   receivers on two events still count twice there). Per event it keeps
   messages, positions by class, the distance bins and the health counters
   (2.8); a duplicate counts on the event that delivered the copy, so
   cross-event duplicates show receiver overlap and the overview's
   duplicate hint then counts same-event copies only. Sectors, coverage,
   vessels and the long-range log stay combined. Sources are labelled by
   event name only (`sources.<label>`, 6.2); a split per NMEA 2000 device
   (`src`) may come later. The only source of message counts, message types and class,
   because SignalK's data model does not retain per-message information.
   `!AIVDO` and NMEA 2000 AIS PGNs marked as own transmissions (the
   vessel's own transponder) are excluded from reception statistics.
2. **Own position** from `navigation.position` on self, and the own
   vessel mode from it and from `navigation.state` on self (2.9).
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
servers fall back to admin-only instead of failing. Read-only users can
therefore open the web app, including when it is embedded in another page
such as an infodisplay panel.

There is one write route, `POST /settings`, which saves live settings (9.1).
It is registered through `router.access('readwrite')`, so the server lets
`admin` and `readwrite` users through (everyone while security is off); on
servers without `router.access` it is admin-only. It accepts only
`Content-Type: application/json` (415 otherwise, so a plain HTML form on
another site cannot post to it) and only the keys of the live settings,
each a number within the schema bounds (400 for anything else, nothing is
clamped). It merges them into the stored plugin configuration, saves it with
`app.savePluginOptions`, applies them to the running plugin without a
restart, clears the cached answers and returns `{ settings }`, the
effective live settings.

| Route | Returns |
|---|---|
| `GET /summary?window=24h` or `?from=&to=`, and `&source=` | headline figures (of one source with `source=<label>`, 5): messages, positions, vessels by group, distance avg, p95, p99 and max, and `health`: the health counts (2.8) and `received`, their denominator |
| `GET /series?metric=&resolution=&from=&to=` | time series for the charts, read from history; `metric` is `messages`, `positions`, `distance`, `vessels` or `health` (each health counter and `received` per bucket), `resolution` in seconds (at least 60, at most 2000 points) |
| `GET /weather?from=&to=` | the configured weather paths (9) read back from history as hourly averages (`aggregate` says `average`, or `last` for a provider that rejects it), buckets starting on the full hour, at most 7 days; only paths with data; `available` is false without a provider and `historyError` is set when the read fails, with no live fallback |
| `GET /sectors?window=24h&class=a\|b\|all` or `?from=&to=&class=` | 24 sectors with count and p99 distance (the highest hourly p99 in the window, see 2.6), and the farthest reception `maxM` with its time: `maxAt` when known exactly, otherwise `maxHour`, the start of the hour it fell in |
| `GET /coverage?window=7d&all=false&cap=&mode=all` or `?from=&to=` | cell ids, GeoJSON for the map, covered area in m²; windows `24h` (today) and `7d`, or `from` and `to` as UTC days (`YYYY-MM-DD`, both included, at most 7) read from the day files only; `retainedFrom` is the oldest day the files are kept for; `all=true` adds the cells beyond the distance cap, marked `capped`; `cap` (50 to 100) tries another distance cap percentile for this answer only, and `capPercentile` gives the percentile applied; `mode` (`all`, `stationary` or `underway`, 2.4) picks the cells of one own vessel mode and is echoed |
| `GET /longrange?window=24h` | the 25 farthest entries of the long-range log (2.7) in the window, farthest first, and the two speed lists of 2.8, 10 senders each, fastest first, speeds in m/s: `fastest` (plausible) and `implausibleJumps`; windows `24h` and `7d` |
| `GET /export/coverage.csv?window=7d&all=false&mode=all` | download: one row per H3 cell, `h3_cell,resolution,reports,min_distance_m,capped`, ordered by cell id; `all=true` adds the cells beyond the distance cap with `capped` true; `mode` as on `/coverage`; no polygons |
| `GET /export/longrange.csv?window=7d&anonymise=false` | download: every long-range entry (2.7) in the window, oldest first, `time,mmsi,name,class,ship_type,distance_m,bearing_deg,lat,lon,own_lat,own_lon`; anonymised, only `time,class,ship_type,distance_m,bearing_deg` |
| `GET /export/longrange.geojson?window=7d` | download: the same entries as GeoJSON points at the reported position, the other fields as properties; full detail only, `anonymise=true` answers 400 |
| `GET /overlay/coverage.geojson` | the plotter overlay's GeoJSON: the 7 day footprint and the 24 hour sector wedges of class A and B |
| `GET /sources` | the sources counted on their own, `{ label, event }` each; empty while `sourceStatistics` is off |
| `GET /status` | live state: tracked targets, own position age, the own vessel `mode` (`stationary`, `underway` or `unknown`, 2.9) and `modeSource` (`state`, `drift` or null), history reachable or not, and per source its messages and health counts since the start |
| `GET /propagation` | the propagation alert (2.10): `{ enabled: false }` while off; otherwise `state` (`unarmed`, `normal`, `alert` or `suppressed`), `ratio`, `p99M`, `baselineM`, `baselineHours`, `vessels` beyond normal, their `sectors`, `since`, the own `mode`, the `rule` in effect and the last 60 `checks` (time, armed, ratio, vessels), from which the web app replays trial settings |
| `POST /settings` | saves live settings (body `{ "coverageDistancePercentile": 95 }`), readwrite users only; see above |

The downloads (decisions on #19) take the windows `24h`, `7d` and `all`.
`24h` and `7d` mean what they mean on `/coverage` (UTC days, `24h` is today)
and `/longrange` (rolling); `all` is every day the files still hold, today
included, which `coverageRetentionDays` decides (8). There is no archive
and no import. They answer as attachments with `Cache-Control: no-store`
and a file name such as `ais-longrange-7d-2026-11-01-anon.csv` (set,
window, UTC day of the export, `-anon` when anonymised; a coverage file
with `all=true` is named `coverage-allcells`, and one of a single mode
carries it after the set, `ais-coverage-underway-7d-...`); errors stay JSON. CSV
follows RFC 4180 (comma, CRLF, header row, UTF-8), numbers in plain
decimals with a dot, times in ISO 8601 UTC, units in SI as the column
names say, an empty field for an unknown name or ship type. Vessel names
are untrusted AIS input, so a text field starting with `=`, `+`, `-`, `@`,
tab or CR gets a leading `'` against spreadsheet formula injection.

Exports carry full detail by default. `anonymise=true` drops the MMSI, the
name, the own position and the target position of every long-range entry,
since a target position with distance and bearing gives the own position
back; time, class, ship type, distance and bearing stay. Coverage is
always its own download and anonymise does not change it: the cells hold
no MMSIs or own position, but a footprint centred on a harbour can hint at
the berth, so the user decides whether to share that file. The fastest and
implausible-jump lists (2.8) are not exported.

Windows accept `1h`, `24h` and `7d`. For the compare view (7, #14)
`/summary` and `/sectors` also take a range instead of a window: `from`
and `to` as ISO times on whole hours, `from` before `to` and before now, at
most 7 days, never together with `window` (400 otherwise). A range that
reaches past now ends now. A range answers with `window: null`, null
unique vessels, and is read hourly from history whenever a provider is
there; without one it comes from the live hour buckets, and `liveFrom`
says where they start when the range reaches back further. The sectors of
a range cover its closed hours from history and the open hour from live
data when the range includes it. Responses are JSON in SI units
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
- `health.decodeErrors`, `health.incomplete`, `health.duplicates`,
  `health.duplicatesCrossEvent`, `health.positionInvalid`,
  `health.implausibleJumps`, `health.noOwnPosition` (2.8)
- With `sourceStatistics` on, per server event (5):
  `sources.<label>.messages.total`, `.positions.classA`, `.classB`,
  `.other`, `.distance.bin.<nn>` and `.health.<kind>`, 43 paths per
  event. `<label>` is the event name with every character other than
  letters and digits replaced by `_`; names that then collide get `_2`,
  `_3` in config order, logged once. There are no per-source gauges, so a
  source's window maximum is known from live data only.

Gauges, in SI units like every SignalK path:
- `distance.avg`, `distance.median`, `distance.p95`, `distance.p99`,
  `distance.max` in metres, over the last hour
- `sectors.<nnn>.<class>.p99` in metres, over the last hour
- `sectors.<nnn>.<class>.max` in metres, the farthest reception in the
  last hour (untrusted, 2.3)
- `vessels.last1h` and `vessels.last24h`, and
  `vessels.byGroup.<group>.last1h` and `.last24h`
- `coverage.area.today` in square metres, and `coverage.cells.today`
- With `propagationAlerts` on, `propagation.ratio`: the recent p99 over the
  normal p99 (2.10), unitless, at every interval once a normal range is
  known

With `propagationAlerts` on, the plugin also raises the notification
`notifications.sensors.ais.statistics.propagation` (2.10). It is the one
output that is not a number and not under `sensors.ais.statistics`: its
value is `{ state, method, message }`, sent when the alert starts and
with `state: normal` when it clears and on stop. History providers do not
need to store it.

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
  from the last known own position (`kind: "sector"`), and per class one
  point at the farthest reception, on its sector's centre bearing
  (`kind: "sector-max"`, with `sector`, `maxM` and its time); that sector's
  wedge carries `farthest: true`. Each sector
  feature carries its class in `cls` (`a` or `b`). A fill layer colours
  cells by `intensity` on a magenta to purple ramp, which contrasts with
  chart water and land, a line layer outlines each cell in the same ramp,
  another line layer outlines the sectors, teal for class A and orange for
  class B as on the web app's sectors page, bolder for the `farthest` one,
  and a circle layer draws the farthest dots in the same class colours.
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

- Overview: type group counts, class A/B split, rates, distance p95 and
  p99, and message health (2.8): the good share, each counter with its
  share, and the duplicate hint. The status line names the own vessel
  mode and what decided it (2.9).
- Charts: positions and messages per hour split by class, distance avg,
  p95 and p99 per hour (max shown separately and marked untrusted), the
  class A and B mix as a share per bucket, and the health shares per
  bucket. On the 24h and 7d windows, a range vs weather section (#15):
  hourly p99 range next to one weather series picked from the configured
  paths (and "Air minus water temperature" when both temperatures have
  data, as a proxy for inversions), the weather on a right axis spanning
  its minimum to maximum, and below it a scatter of hourly p99 against that
  series with Pearson's r. Hours with fewer than 20 reports stay out of the
  scatter and r, the same minimum as the sectors (2.6); r needs at least
  24 such hours. The choice of series is remembered per browser. The
  section shows only with a history provider that holds at least one of
  the paths; the 1h window shows a note instead. Weather values use the
  path's display unit, otherwise hPa for pressure, °C for temperature and
  percent for ratios.
- Sectors: the 24-sector bearing view for class A and B (`#/sectors`), where the
  sector with the chart's farthest reception is outlined bolder and has a
  dot at that distance (hover shows distance and time; a dot beyond the
  scale sits hollow on the rim, and hovering a wedge shows its farthest
  reception too), and below it a
  table of the farthest receptions from the long-range log (2.7): time,
  distance, bearing, class, vessel name and MMSI, its position and the own
  position. Below that, the fastest vessels and the implausible jumps
  (2.8), each with time, implied speed, reported speed over ground, the
  limit, the time between the two positions, class, vessel and both
  positions, rows in the class colours of the sectors view. Under the
  farthest receptions table, download links (6.1) for the table's window
  and for all retained days, as CSV and GeoJSON, with an `Anonymise`
  checkbox; while it is ticked the GeoJSON links are greyed out.
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
  Under the map, a `Cells from` selector (All, Stationary, Underway, 2.4)
  shows the cells of one own vessel mode; it is part of the hash route
  (`#/map?window=7d&mode=underway`), not saved, and the info line says
  that the sectors are not split. The plotter overlay stays combined.
  Below it, a distance cap slider (50th percentile to off) redraws the
  cells at once and offers save and reset (live settings, 9.1). Below it,
  coverage CSV downloads (6.1) for the shown window and for all retained
  days, of the selected mode, including the cells beyond the cap while `All cells` is on, with a
  one-line note that a footprint can hint at the berth.
- Compare (#14): two date windows side by side, to tell whether an
  antenna, cable, splitter or receiver change helped
  (`#/compare?date=YYYY-MM-DD&days=7`). The date is the first UTC day of
  the after window; the before window is the same number of days (1 to 7,
  default 7) before it. The default date puts the after window's end on
  today, so both fit the default coverage retention. A table gives per
  window messages, positions by class, distance p99, p95, median, average
  and maximum (marked untrusted), coverage cells and area, and the change
  with its percentage. An after window that reaches today is shorter;
  counts are then compared per hour, distances and coverage as they are.
  Below the table, both sector charts (all classes) on one scale. Notes say
  when a window starts before the oldest kept coverage day (coverage is then
  shown as not kept, not as a smaller area), when live data covers only
  part of a window, and when history failed. With `sourceStatistics` on, a
  source picker limits the table to one server event; the sectors and
  coverage stay combined and the view says so. The state is in the hash,
  not in the plugin config. Markers for a change on the charts come later.
- Propagation alert (2.10): while the server's notification is active, a
  banner under the offline banner shows its message, live over the one
  WebSocket, and links to the sectors page. There, with alerts on, a card
  at the top shows the state (learning the normal range, no alert, alert
  since, or held back while underway) and sliders for the factor, vessel
  count and duration (9.1). The web app replays the last hour of checks
  with the slider values and says whether an alert would be active now, so
  the effect shows before saving.
- Settings: a collapsed panel at the foot of every page lists the settings
  in effect, read only, and says where to change them.

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
  Speeds in the display unit of `navigation.speedOverGround`, otherwise
  knots.
- Ship time without a zone suffix when `environment.time.timezoneOffset`
  is published, otherwise UTC with `Z`; dates as `YYYY-MM-DD`.
- Views selected by hash routes (`#/charts?window=7d`); one WebSocket for
  mode, time offset, internet state and the propagation alert, throttled to one update per 5 s,
  reconnecting with backoff and showing an offline banner while down.
- A button or tab whose click starts a load fades out and in, one cycle
  per 0.5 s, until the load ends (chosen by the maintainer). Loads under
  200 ms do not blink, the minute refresh shows nothing, and with reduced
  motion the control dims instead.
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
  path filters must allow `sensors.ais.statistics.*`, and the weather paths
  (9) for the range vs weather section.
- Readers may only rely on aggregates every provider is expected to have.
  The provider checked offers `average`, `min`, `max`, `first`, `last`,
  `mid`, `middle_index`, `sma` and `ema`, with no `sum` or `count`. The
  plugin uses `last` and `max` only, which is why counts are published as
  cumulative counters (4.1). The one exception is the weather paths, read
  with `average` for hourly means (chosen by the maintainer); a weather
  read the provider rejects is retried with `last`, which the plugin then
  keeps using until it restarts.
- The one thing the History API cannot carry is the set of covered H3
  cells. The plugin therefore writes one small cell-set file per UTC day in
  its own data directory (a few KB), `coverage-YYYY-MM-DD.json`, pruned by
  `coverageRetentionDays` (default 14; the 7 day map window and the
  overlay need at least 7). From file version 2 it holds one cell map per
  own vessel mode (`modes.stationary`, `modes.underway`, `modes.unknown`,
  2.4); per cell the shortest distance seen and the report count. It also
  holds that day's distance histogram over all modes, so a window's
  coverage cap is computed from the files alone. A day holds at most 20000
  cells, a cell seen in two modes counting twice. A version 1 file (one
  `cells` map) loads with its cells under unknown, and today's file is
  written as version 2 at the next flush; version 1 code does not read a
  version 2 file, so after a downgrade the map starts empty until the
  files of the newer version are pruned. Files are written atomically every hour,
  at the UTC day change and on stop, and today's file is merged back in on
  start.
- The long-range log (2.7) is kept the same way, one file per UTC day,
  `longrange-YYYY-MM-DD.json`, at most 50 entries (about 15 KB) and, from
  file version 2, the two speed lists (2.8, at most 10 each, about 6 KB), written
  hourly, at the day change and on stop, loaded back on start and pruned
  with the cell files. The downloads (6.1) read these files, so
  `coverageRetentionDays` is also how far back an export reaches. A version 1 file loads with an empty fastest list,
  and version 1 code reads a version 2 file's farthest entries and ignores
  the rest. Everything else is stateless across restarts, including the
  propagation alert (2.10), which learns its normal range from history; the
  last counter values are published once more on stop.

## 9. Configuration

The server's config form shows the options in groups, in the order of
`CONFIG_ORDER` in `src/config.ts`, passed as the plugin's `uiSchema`: AIS
input, publishing, coverage, vessel mode, message health, weather,
propagation alerts. The README's configuration table follows the
same order, which a test checks. The defaults were reviewed for 1.0.0 on
2026-11-01 and kept.

| Option | Default | Notes |
|---|---|---|
| `targetExpirySeconds` | 3600 | live tracking expiry |
| `h3Resolution` | 6 | coverage cell size: 6 is about 7 km across (36 km²); 5 was too coarse (chosen by the maintainer) |
| `coverageDistancePercentile` | 99 | coverage skips cells with fewer than 3 reports beyond this percentile of the window's distances; 100 disables the cap |
| `ownPositionMaxAgeSeconds` | 60 | staleness limit for own position |
| `coverageRetentionDays` | 14 | how long daily cell-set and long-range log files are kept; the map and the overlay show up to 7 days, so two weeks leaves room (chosen by the maintainer); also the reach of an `all` download |
| `publishIntervalMinutes` | 5 | how often the statistics paths are published; a divisor of 60; sector paths go out hourly regardless |
| `publishOverlay` | true | register the plotter extension overlay |
| `sentenceEvents` | `nmea0183`, `N2KAnalyzerOut` | server events to read AIS from: raw sentences or canboat PGNs; any event names |
| `sourceStatistics` | false | also count each server event on its own (5); 43 more counter paths per event at every interval, about 12,400 history rows a day each at 5 minutes, so two events about double the history load |
| `jumpSpeedLimitKnots` | 60 | implied speed above which a position counts as an implausible jump (2.8) |
| `jumpSpeedLimitHighSpeedKnots` | 120 | the same for ship types 20 to 29 (WIG) and 40 to 49 (high-speed craft) |
| `jumpSpeedLimitAircraftKnots` | 600 | the same for message 9 (SAR aircraft) |
| `modeDriftRadiusMeters` | 200 | without a recognised `navigation.state`, stationary while the own position stays within this distance (2.9); 50 to 2000 |
| `modeDriftMinutes` | 10 | for this long; 2 to 60 |
| `propagationAlerts` | false | raise the propagation alert (2.10) and publish `propagation.ratio` (chosen by the maintainer) |
| `propagationFactor` | 2 | recent p99 over the normal p99 that counts as an opening; 1.2 to 10; live setting |
| `propagationMinVessels` | 3 | distinct vessels beyond the normal p99 in the window; 1 to 50; live setting |
| `propagationSustainMinutes` | 15 | how long both conditions must hold to fire, and fail to clear; 1 to 60; live setting |
| `propagationWindowMinutes` | 15 | the recent window of the check; 5 to 60 (a setting of its own, chosen by the maintainer) |
| `propagationNotificationState` | `warn` | `alert`, `warn`, `alarm` or `emergency` |
| `propagationNotificationMethods` | `visual` | `visual` and `sound`; visual alone asks displays to stay silent |
| `propagationSuppressUnderway` | true | hold the alert back while underway |
| `weatherPaths` | `environment.outside.pressure`, `environment.outside.temperature`, `environment.outside.relativeHumidity`, `environment.water.temperature` | numeric paths of this vessel for range vs weather (7), read from history; at most 8 (one history request), dotted names without wildcards; an empty list hides the section |

### 9.1 Live settings

Settings worth changing while watching their effect have controls in the
web app (chosen by the maintainer). A change applies to the view at once,
through a query parameter of a read route, and is stored only when the user
presses save, which `POST /settings` (6.1) handles. The save button shows
only when security is off or `/skServer/loginStatus` reports the user as
`readwrite` or `admin`. Every other option stays in the server's plugin
config form only.

The live settings are listed once, in `LIVE_SETTINGS` in `src/config.ts`:

| Option | Web app control |
|---|---|
| `coverageDistancePercentile` | slider on the map, 50 to 100; tried with `GET /coverage?cap=` |
| `propagationFactor` | slider on the sectors page, 1.2 to 10 |
| `propagationMinVessels` | slider on the sectors page, 1 to 50 |
| `propagationSustainMinutes` | slider on the sectors page, 1 to 60 minutes |

The alert sliders are tried by replaying the last hour of checks from
`GET /propagation` in the web app, so they need no query parameter. The
plotter overlay always uses the saved coverage cap.

## 10. MVP Scope

### 10.1 MVP Features

- Raw sentence ingestion, class and type group classification.
- Rates and vessel counts per minute and hour.
- Distance statistics (avg, median, p95, p99, max) over all positions, with
  no filtering.
- 24 bearing sectors per class, from per-sector p99.
- Coverage cells and area per day.
- SignalK path publication (6.2).
- Web app with overview, charts, sectors, map and compare (7).
- Overlay resource set for chart plotters (6.3).

### 10.2 Post-MVP / Deferred

- Availability, gaps and last-signal age: not in the MVP; the definition
  needs care (see 1.2) and the data needed for it (gap tracking with an
  injectable clock) is separable.
- Optional rejection of bogus positions (range cap, speed filter): not
  needed while percentiles carry the distance figures and coverage has its
  own percentile cap. The implausible jump counter (2.8) counts what a
  speed filter would catch without dropping anything.
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
  view marks the chart's farthest reception with a dot and a bolder sector
  outline, shows each sector's maximum and time on hover, and the
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
  counted twice; the option's description says so, and the cross-event
  duplicate counter (2.8) shows it.
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

- **Message health only counts (chosen by the maintainer).** Duplicates,
  implausible jumps and invalid positions are counters (2.8), and nothing
  is dropped (2.3). The duplicate key is MMSI, type and near-identical
  position within a fixed 2 s, so it works across both decoders; a payload
  hash was rejected because NMEA 0183 and NMEA 2000 copies differ in form.
  The jump limits allow for SAR aircraft and high-speed and WIG craft. The
  fastest list lives in the long-range file, so the plugin owns no new kind
  of state, and is ranked by implied speed with the reported speed over
  ground beside it, plausible speeds and implausible jumps in separate top
  10 lists.

- **Range vs weather reads the weather from history (chosen by the
  maintainer, #15).** The weather is already on the server, so the plugin
  publishes and stores nothing for it and the section needs a history
  provider. The series are any numeric paths from a setting, defaulting to
  the standard weather paths. Hourly averages are read, a documented
  exception to the `last` and `max` rule (8) with a fallback to `last`;
  only one provider has been checked for `average`. The range side reuses
  the hourly distance series the charts already load, so the section adds
  one history request. Correlation is shown as the plots and Pearson's r;
  hours with fewer than 20 reports stay out of r, as for the sectors. The
  window stays at most 7 days.

- **Antenna and receiver comparison starts with date windows (chosen by
  the maintainer, #14).** Two windows side by side from data the plugin
  already keeps, so the compare view adds no paths and no history load;
  each window is at most 7 days, like every other window. Change markers on
  the charts come later. Statistics per server event are opt-in, because
  each event adds about as many history rows a day as the main figures;
  they cover messages, positions, distance figures from per-source bins
  and message health, labelled by event name only, while sectors,
  coverage and vessels stay combined. A split per NMEA 2000 device comes
  later, if at all.

- **Stationary and underway split coverage only (chosen by the
  maintainer, #17).** `navigation.state` decides when it is recognised,
  and is trusted even when it may be stale; otherwise position drift
  decides, about 200 m for 10 minutes, both settings. Only the coverage
  cells are kept per mode, in the existing day file, so there are no new
  paths and range, sectors and counts stay combined. The mode is decided
  at reception and not revised, accepting that a boat that has just
  stopped counts as underway for the first minutes. There is no footprint
  per mooring spot (the #14 date compare covers a change of berth), and
  the plotter overlay stays one combined footprint.
- **Propagation alerts compare against a 7 day median (chosen by the
  maintainer, #13).** Normal is the median hourly p99 of 7 days, without a
  time-of-day baseline; an opening is 2 times that, with 3 vessels beyond
  it, for 15 minutes, all three settings and live in the web app. Distinct
  vessels guard against one bogus position, so the trigger uses the p99
  and never the maximum. The alert clears after the same time without the
  conditions, rather than at a lower threshold, and the recent window is a
  setting of its own. Alerts are off by default; when on they are a
  `warn`, visual only, and held back while underway, all settings. The
  baseline is read from the bin counters through history rather than
  stored, so the plugin owns no new state. Per-source alerts are not
  planned.

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

2. **How displays show the propagation alert.** How the notification
   (2.10) appears in the admin UI, Freeboard-SK and KIP, and whether
   `method: ["visual"]` keeps each of them silent, is unchecked (the
   maintainer chose to skip the check for now). Check on a development
   server and record it in docs/findings.md.
