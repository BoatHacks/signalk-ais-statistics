# MVP Roadmap

Ordered work items for the MVP in [SPEC.md](../../SPEC.md) section 10.1. Each
item becomes an issue and gets its own plan from
[plan-template.md](plan-template.md) before implementation starts. The order
follows dependencies: pure logic first, then publishing, then the things
that read it back.

## 0. Spikes (answer SPEC section 13 before depending on it)

Small throwaway experiments, each ending in an update to section 13 and, if
the answer differs from the assumption, to SPEC.md or ARCHITECTURE.md.
Items 1 to 8 are implemented, each with a plan in this directory
(`item-<n>-<slug>.md`); the counter reset spike ran against the
development server; the Freeboard-SK check
remains.

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
- [x] **Counter reset.** The restart shows as a plain drop; a restart
      inside a bucket needed `max` as well as `last` (SPEC 6.2).
- [ ] **Overlay size.** The overlay is served and small (SPEC 6.3); whether
      it stays smooth in Freeboard-SK needs a look in the plotter. (13.1)
- [x] **NMEA 2000 AIS.** It only arrives on `nmea0183AISout` from a
      converter plugin; the sentence events are configurable (SPEC 5).

## 1. Plugin scaffold

- [x] TypeScript project, plugin entry, config schema (SPEC section 9)
- [x] Vitest, type check, lint and format scripts; CI running them
      (the SignalK reusable plugin CI workflow is added with the first
      release, pinned to a release SHA)
- [x] `paths.ts` with every published path name
- [x] Release workflow (npm trusted publishing) and package metadata;
      the remaining registry items from [docs/release.md](../release.md)
      are part of item 9

## 2. Ingest, decode, classify

- [x] Sentence reassembly and decode with `ggencoder`, per-sentence error
      containment (ARCHITECTURE 2.1)
- [x] Class and type-group mapping (SPEC 2.1)
- [x] Own position tracker with staleness (ARCHITECTURE 2.2)
- [x] Synthetic AIS fixtures covering class A and B, multipart, bad
      checksums and out-of-range positions

## 3. Aggregation

- [x] Minute and hour buckets, rates, unique vessels per type group
      (SPEC 2.5)
- [x] Distance histogram with average, median, p95, p99 and max (SPEC 2.3)
- [x] 24-sector per-class counts and p99 (SPEC 2.6)
- [x] Geo helpers: haversine, bearing, sector

## 4. Publishing

- [x] Counters and gauges every minute with the plugin as source
      (SPEC 4.1, 6.2)
- [x] Only numeric values published; verify against the spike results

## 5. Query layer and REST API

- [x] HistoryReader on the History API, and the null reader for live-only
      mode (ARCHITECTURE 2.7)
- [x] Query layer merging live and historical data: window totals from
      counter differences with reset detection, window percentiles from the
      distance bin counters
- [x] Routes registered read-only through `router.access`, with the guard
      for older servers (SPEC 6.1)

## 6. Coverage

- [x] H3 cell set per UTC day, hourly flush to the daily file, retention
      (SPEC 2.4, 8)
- [x] Coverage percentile cap applied when building a window footprint
- [x] `/coverage` route and GeoJSON output

## 7. Web app

- [x] Overview, charts, radar and map views (SPEC 7)
- [x] Basemap switch with the online and metered default, remembered choice
- [x] Works at phone width and offline, no CDN assets

## 8. Chart plotter overlay

- [x] `plotterExtensions` provider serving the manifest only while running
      (ARCHITECTURE 2.10)
- [x] MapLibre style (inline in the manifest) and GeoJSON route,
      background page calling `overlay.refresh`
- [ ] Checked in Freeboard-SK

## 9. First release

- [ ] Work through [docs/release.md](../release.md): package metadata,
      registry score items, first manual publish, trusted publisher
- [ ] README with install, configuration and screenshots that contain no
      real vessel data
- [ ] Review SPEC.md and ARCHITECTURE.md against the code and resolve or
      remove section 13
- [ ] Privacy pass over the repository and its history before it is made
      public
