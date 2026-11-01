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

## Placeholders

- `<nn>`: distance bin, two digits, `00` to `31`. Bin `00` is below 0.5 nm,
  bins `01` to `30` split 0.5 to 512 nm into steps of 2^(1/3) (about 26
  percent wide), and bin `31` is 512 nm and beyond, where bogus positions
  land. Bin `nn` always means the same distance range.
- `<nnn>`: bearing sector, the starting true bearing in degrees as three
  digits, `000` to `345`, 15 degrees wide, clockwise from north.
- `<class>`: `a` or `b`, the AIS class of the reporting vessel.
- `<group>`: `cargo`, `tanker`, `passenger`, `fishing`, `pleasureCraft`,
  `other` or `unknown`, from the AIS ship type.

That makes 32 bin paths, 48 paths each for sector counts, p99 and maximum,
and 14 per type group paths.

## History provider setup

A history provider that records `sensors.ais.statistics.*` lets the web app
show windows longer than the plugin's uptime. About 14 days of retention
covers the longest window (7 days) with room to spare. The plugin reads
history with the `last` and `max` aggregates only.
