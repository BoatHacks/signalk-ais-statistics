# Published paths

The plugin publishes these paths on the own vessel (`vessels.self`), all
under `sensors.ais.statistics.`, with the source label
`signalk-ais-statistics`. Every value is a number. SPEC 6.2 explains why the
paths look the way they do; `src/paths.ts` defines them, and
`test/paths-doc.test.ts` checks this page against it.

**No stability promise yet.** Names, units and cadence may still change
before 1.0.0 and until user feedback settles them. A change is listed in
the CHANGELOG. The same holds for the REST API, the plotter overlay and the
export formats.

## Kinds

- **counter**: counted since the plugin started, so it only rises until
  the plugin restarts and then starts again from zero. A window's count is
  the rise between its first and last value; readers use the `last` and
  `max` aggregates to see a restart (SPEC 6.2). Do not chart a counter
  directly; chart its rate.
- **gauge**: a current value, over the period named in the table. A gauge
  without data, for example no reception with a known own position in the
  last hour, is left out of the delta rather than published as zero.

## Cadence

- **interval**: every publish interval (`publishIntervalMinutes`, default 5
  minutes), changed or not, and on stop.
- **hourly**: once an hour, on the first publish after a start, and on
  stop. The sector figures keep the highest hourly p99 and the maximum, so
  finer updates add nothing.

## Paths

Units are SI, as everywhere in SignalK: the plugin sets default metadata
(`units`, and the `distance` display category for distances) so the server's
unit preferences convert them for display. A blank unit is a plain count.

| Path | Unit | Kind | Cadence | Meaning |
|---|---|---|---|---|
| `messages.total` | | counter | interval | Decoded AIS messages |
| `positions.classA` | | counter | interval | Class A position reports |
| `positions.classB` | | counter | interval | Class B position reports |
| `positions.other` | | counter | interval | Other position reports (base stations, aids to navigation, SAR aircraft) |
| `distance.bin.<nn>` | | counter | interval | Position reports per distance bin, `00` to `31` (below) |
| `sectors.<nnn>.<class>.count` | | counter | hourly | Position reports per bearing sector and class |
| `health.decodeErrors` | | counter | interval | AIS sentences or PGNs that could not be decoded (bad checksum, malformed, missing a part) |
| `health.incomplete` | | counter | interval | Multipart messages dropped because a part never arrived |
| `health.duplicates` | | counter | interval | Messages repeated on the same event within 2 s (same MMSI, type and position) |
| `health.duplicatesCrossEvent` | | counter | interval | Messages that arrived on two configured events within 2 s: one receiver reaching both |
| `health.positionInvalid` | | counter | interval | Position reports without a usable position (out of range or "not available") |
| `health.implausibleJumps` | | counter | interval | Positions implying a speed above the sender's jump limit; one bogus position counts twice (out and back) |
| `health.noOwnPosition` | | counter | interval | Position reports received while the own position was unknown or stale |
| `distance.avg` | m | gauge | interval | Average reception distance, last hour |
| `distance.median` | m | gauge | interval | Median reception distance, last hour |
| `distance.p95` | m | gauge | interval | 95th percentile reception distance, last hour |
| `distance.p99` | m | gauge | interval | 99th percentile reception distance, last hour |
| `distance.max` | m | gauge | interval | Farthest reception, last hour (untrusted: one bogus position sets it) |
| `sectors.<nnn>.<class>.p99` | m | gauge | hourly | 99th percentile distance per sector and class, last hour |
| `sectors.<nnn>.<class>.max` | m | gauge | hourly | Farthest reception per sector and class, last hour (untrusted) |
| `vessels.last1h` | | gauge | interval | Distinct vessels heard, last hour |
| `vessels.last24h` | | gauge | interval | Distinct vessels heard, last 24 hours |
| `vessels.byGroup.<group>.last1h` | | gauge | interval | Distinct vessels per type group, last hour |
| `vessels.byGroup.<group>.last24h` | | gauge | interval | Distinct vessels per type group, last 24 hours |
| `coverage.cells.today` | | gauge | interval | Coverage cells today (UTC) |
| `coverage.area.today` | m2 | gauge | interval | Area of the coverage cells today (UTC) |
| `propagation.ratio` | ratio | gauge | interval | Recent p99 distance over the normal p99 (only with `propagationAlerts`) |
| `sources.<label>.messages.total` | | counter | interval | Decoded AIS messages on one server event (only with `sourceStatistics`) |
| `sources.<label>.positions.classA` | | counter | interval | Class A position reports on one server event |
| `sources.<label>.positions.classB` | | counter | interval | Class B position reports on one server event |
| `sources.<label>.positions.other` | | counter | interval | Other position reports on one server event |
| `sources.<label>.distance.bin.<nn>` | | counter | interval | Position reports per distance bin on one server event |
| `sources.<label>.health.decodeErrors` | | counter | interval | Undecodable sentences or PGNs on one server event |
| `sources.<label>.health.incomplete` | | counter | interval | Incomplete multipart messages on one server event |
| `sources.<label>.health.duplicates` | | counter | interval | Copies of a message seen on the same server event within 2 s |
| `sources.<label>.health.duplicatesCrossEvent` | | counter | interval | Copies on this event of a message first seen on another event within 2 s: receiver overlap |
| `sources.<label>.health.positionInvalid` | | counter | interval | Position reports without a usable position on one server event |
| `sources.<label>.health.implausibleJumps` | | counter | interval | Implausible position jumps delivered by one server event |
| `sources.<label>.health.noOwnPosition` | | counter | interval | Position reports on one server event while the own position was unknown or stale |

The `sources.*` paths exist only while the `sourceStatistics` setting is
on: one set of 43 counters per configured server event, beside the main
figures, which still count every event (a receiver on two events counts
twice there). There are no per-source gauges; window figures come from
the bins, as for the main statistics.

`propagation.ratio` exists only while the `propagationAlerts` setting is
on, and is left out until a normal range is known. It divides the p99
distance of the recent window (`propagationWindowMinutes`, default 15) by
the median hourly p99 of the last 7 days (SPEC 2.10); 2 means range is
twice normal.

## Notification

With `propagationAlerts` on, the plugin also raises the SignalK
notification `notifications.sensors.ais.statistics.propagation`. Its value
is an object, not a number: `state` (`warn` by default, a setting),
`method` (`["visual"]` by default, a setting) and `message`, which names the
ratio, both distances, the vessels beyond normal and their sectors. It is
sent when the alert starts, and with `state: "normal"` when it clears and
when the plugin stops.

The `health.*` counters only count: a duplicate, a jump or a message
received without an own position still counts everywhere else (SPEC 2.8).
A share over a window divides a counter's rise by the rise of
`messages.total` plus `health.decodeErrors` and `health.incomplete`, which
is everything received.

## Placeholders

- `<nn>`: distance bin, two digits, `00` to `31`. Bin `00` is below 0.5 nm,
  bins `01` to `30` split 0.5 to 512 nm into steps of 2^(1/3) (about 26
  percent wide), and bin `31` is 512 nm and beyond, where bogus positions
  land. Bin `nn` always means the same distance range.
- `<nnn>`: bearing sector, the starting true bearing in degrees as three
  digits, `000` to `345`, 15 degrees wide, clockwise from north.
- `<class>`: `a` or `b`, the AIS class of the reporting vessel.
- `<label>`: the server event name with every character other than
  letters and digits replaced by `_`, for example `nmea0183` or
  `N2KAnalyzerOut`. Two events that map to the same label get `_2`, `_3`
  in the order they are configured.
- `<group>`: `cargo`, `tanker`, `passenger`, `fishing`, `pleasureCraft`,
  `other` or `unknown`, from the AIS ship type.

That makes 32 bin paths, 48 paths each for sector counts, p99 and maximum,
and 14 per type group paths, plus 43 per server event with
`sourceStatistics` on.

## History provider setup

A history provider that records `sensors.ais.statistics.*` lets the web app
show windows longer than the plugin's uptime. About 14 days of retention
covers the longest window (7 days) with room to spare. The plugin reads
history with the `last` and `max` aggregates only.
