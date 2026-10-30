# MVP Roadmap

Ordered work items for the MVP in [SPEC.md](../../SPEC.md) section 10.1. Each
item becomes an issue and gets its own plan from
[plan-template.md](plan-template.md) before implementation starts. The order
follows dependencies: pure logic first, then publishing, then the things
that read it back.

## 0. Spikes (answer SPEC section 13 before depending on it)

Small throwaway experiments, each ending in an update to section 13 and, if
the answer differs from the assumption, to SPEC.md or ARCHITECTURE.md.

- [x] **`nmea0183` event payload.** The event delivers the raw sentence as a
      plain string with no source or timestamp (checked in an existing
      plugin's handler). Recorded in ARCHITECTURE section 5.
- [x] **History API aggregates.** A provider accepts `average`, `min`, `max`,
      `first`, `last`, `mid`, `middle_index`, `sma` and `ema`; no `sum` or
      `count`. Hence cumulative counters (SPEC 4.1).
- [x] **Empty and sparse buckets.** `last` returns `null` before the first
      sample and repeats the previous value for buckets without a new
      sample; `resolution` is required. Recorded in SPEC section 8.
- [x] **Path namespace.** `sensors.ais.statistics.*` conflicts with no
      defined schema key (SPEC section 12).
- [ ] **Counter reset.** Publish a test counter from the plugin, restart it
      and confirm the reader detects the reset. (13.1)
- [ ] **Overlay size.** Serve a GeoJSON source of a few hundred H3 cells to a
      plotter extension data overlay and check that it stays smooth. (13.2)

## 1. Plugin scaffold

- [ ] TypeScript project, plugin entry, config schema (SPEC section 9)
- [ ] Vitest, type check, lint and format scripts; CI running them
- [ ] `paths.ts` with every published path name
- [ ] Release workflow (npm trusted publishing)

## 2. Ingest, decode, classify

- [ ] Sentence reassembly and decode with `ggencoder`, per-sentence error
      containment (ARCHITECTURE 2.1)
- [ ] Class and type-group mapping (SPEC 2.1)
- [ ] Own position tracker with staleness (ARCHITECTURE 2.2)
- [ ] Synthetic AIS fixtures covering class A and B, multipart, bad
      checksums and out-of-range positions

## 3. Aggregation

- [ ] Minute and hour buckets, rates, unique vessels per type group
      (SPEC 2.5)
- [ ] Distance histogram with average, median, p95, p99 and max (SPEC 2.3)
- [ ] 24-sector per-class counts and p99 (SPEC 2.6)
- [ ] Geo helpers: haversine, bearing, sector

## 4. Publishing

- [ ] Counters and gauges every minute with the plugin as source
      (SPEC 4.1, 6.2)
- [ ] Only numeric values published; verify against the spike results

## 5. Query layer and REST API

- [ ] HistoryReader on the History API, and the null reader for live-only
      mode (ARCHITECTURE 2.7)
- [ ] Query layer merging live and historical data: window totals from
      counter differences with reset detection, window percentiles from the
      distance bin counters
- [ ] Routes registered read-only through `router.access`, with the guard
      for older servers (SPEC 6.1)

## 6. Coverage

- [ ] H3 cell set per UTC day, hourly flush to the daily file, retention
      (SPEC 2.4, 8)
- [ ] Coverage percentile cap applied when building a window footprint
- [ ] `/coverage` route and GeoJSON output

## 7. Web app

- [ ] Overview, charts, radar and map views (SPEC 7)
- [ ] Basemap switch with the online and metered default, remembered choice
- [ ] Works at phone width and offline, no CDN assets

## 8. Chart plotter overlay

- [ ] `plotterExtensions` provider serving the manifest only while running
      (ARCHITECTURE 2.10)
- [ ] MapLibre style and GeoJSON, background page calling `overlay.refresh`
- [ ] Checked in Freeboard-SK

## 9. First release

- [ ] README with install, configuration and screenshots that contain no
      real vessel data
- [ ] Review SPEC.md and ARCHITECTURE.md against the code and resolve or
      remove section 13
- [ ] Privacy pass over the repository and its history before it is made
      public
