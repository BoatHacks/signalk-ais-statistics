# Implementation Plan: #17 stationary vs underway coverage

## Overview
Classify the own vessel as stationary or underway and keep coverage cells
per mode in the daily coverage file, so a 7 day footprint from the berth is
not mixed with cells collected along a passage. The mode is also exposed to
the plugin so #13 can suppress propagation alerts while underway.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 1.2, 2.4, 6.1, 7, 8, 9 and 12; ARCHITECTURE 1, 2.2, 2.5, 2.9, 2.11
and 7. Maintainer decisions 17 to 19 (and 4 for #13) in the issue comment.

## Approach
- **Mode signal** (decision 17), in a pure `VesselMode` class in
  `src/mode.ts` with an injectable clock (times passed in, no I/O):
  - `navigation.state` decides whenever a recognised value has been seen.
    Stationary: `moored`, `anchored`, `not under way`, `aground`. Underway:
    `sailing`, `motoring` and the other movement values of the SignalK
    schema enum (towing, pushing, fishing, restricted manoeuvrability,
    constrained by draft). Anything else (`default`, null, unknown strings)
    counts as not available and drift decides.
  - Drift: own positions sampled at most every 10 s, kept for the last
    `modeDriftMinutes`. Stationary when the samples span the full window,
    have no gap longer than `ownPositionMaxAgeSeconds`, and all lie within
    `modeDriftRadiusMeters` of their mean. Once stationary, the mean is the
    anchor and the vessel turns underway as soon as a position lies beyond
    the radius from it. Underway also when the window is full but the
    spread exceeds the radius. Before the window fills after a start or a
    gap, the mode is `unknown`. At most about 60 samples are held.
  - The mode is decided at reception and never revised. A boat that has
    just stopped counts as underway for the first `modeDriftMinutes`; that
    lag is accepted rather than rewriting cells after the fact.
- **Settings** (SPEC 9, server config form only, decision 25):
  `modeDriftRadiusMeters` default 200 (clamped 50 to 2000) and
  `modeDriftMinutes` default 10 (clamped 2 to 60). The default radius
  allows for an anchored boat swinging on its rode.
- **What is split** (decision 18): coverage cells only. No new paths,
  `src/paths.ts` is unchanged, `coverage.cells.today` and
  `coverage.area.today` stay combined, and range, histograms, sectors and
  the radar are not split. Nothing is filtered: a report with mode
  `unknown` still lands in coverage, under `unknown`.
- **Coverage file, version 2** (SPEC 8): `{ version: 2, date, resolution,
  distanceBins, modes: { stationary, underway, unknown } }`, each mode a
  cell map of `[shortest distance, reports]` as today. `distanceBins` stays
  one per day, so the percentile cap of every view comes from the same
  combined histogram and the stationary and underway footprints are exact
  subsets of the combined one. The 20000 cell limit counts mode and cell
  pairs, so a cell seen in two modes counts twice.
- **Existing files**: a version 1 file (top level `cells`) loads with all
  its cells under `unknown`; it appears in the combined view and in neither
  mode view. Files are always written as version 2, so today's file is
  upgraded at the next flush and older days stay version 1 until pruned.
  A downgraded plugin rejects version 2 files; the release notes say so.
- **REST** (SPEC 6.1): `GET /coverage` takes `mode=all|stationary|underway`
  (default `all`, anything else is a 400) and echoes `mode`. `/status`
  adds `mode` and `modeSource` (`state`, `drift` or null). Both stay
  read-only.
- **Map** (SPEC 7): a mode selector (All, Stationary, Underway) next to the
  window selector, kept in the hash route (`#/map?window=7d&mode=underway`)
  and not saved. The info line names the mode and says that the radar is
  not split. No marker per mooring spot (decision 19; a change of berth is
  covered by the #14 date compare).
- **Overlay** (SPEC 6.3): unchanged, the combined 7 day footprint. No
  second overlay unless the maintainer asks (Open Points).
- **For #13**: `Running` holds the `VesselMode`; #13 reads `mode.current()`
  for its underway suppression setting (decision 4). #17 adds no alert code.

## Test Strategy
Unit tests with synthetic positions generated from an arbitrary open-sea
point and offsets in metres; no recorded data.
- `test/mode.test.ts`: each `navigation.state` value maps as listed;
  unrecognised and null values fall back to drift; a state overrides drift;
  drift within 180 m for 10 minutes turns stationary; a swing pattern
  around an anchor stays stationary; leaving the radius turns underway at
  once; `unknown` before the window fills and after a gap; sample bound.
- `test/coverage.test.ts`: per-mode cells; mode footprints are subsets of
  `all`; cap from the combined bins; version 1 file loads as `unknown`;
  version 2 round trip and restart merge; cell limit across modes;
  corrupt `modes` entries are skipped.
- `test/api.test.ts`: `mode` default, values and 400. `test/config.test.ts`:
  defaults and clamps. `test/plugin.test.ts`: the `navigation.state` stream
  reaches the mode and located reports carry it; the app fixture's
  `getSelfStream` becomes path aware. `test/web`: route parsing of `mode`.

## Implementation Steps
- [ ] Check the `navigation.state` enum in `@signalk/signalk-schema` and
      record it in `docs/findings.md`
- [ ] Tests for mode, coverage v2, route, config, plugin wiring (own commit)
- [ ] `src/mode.ts`, config options, coverage v2 with the v1 reader
- [ ] Plugin wiring: `navigation.state` self stream, mode into
      `coverage.add`, `/status` fields, `/coverage?mode=`
- [ ] Web app: mode selector, route, info line
- [ ] Docs: SPEC 2.4 (split), a new 2.8 for the mode rules, 6.1, 7, 8
      (file version 2), 9 (options), 12 (decisions 17 to 19, chosen by the
      maintainer); ARCHITECTURE 1, 2.2 (VesselMode next to OwnPosition),
      2.5, 2.9, 2.11, 7; README "What it does" and status; roadmap entry

## Files to Create/Modify
`src/mode.ts` (new), `src/config.ts`, `src/coverage.ts`, `src/plugin.ts`,
`src/api.ts`, `web/src/map.ts`, `web/src/route.ts`, `web/src/api.ts`,
`web/src/main.ts`, `test/mode.test.ts` (new), `test/coverage.test.ts`,
`test/api.test.ts`, `test/config.test.ts`, `test/plugin.test.ts`,
`test/fixtures/app.ts`, `test/web/route.test.ts`, `SPEC.md`,
`ARCHITECTURE.md`, `README.md`, `docs/findings.md`, the roadmap.

## Open Points
- The exact `navigation.state` enum (no `node_modules` copy was at hand
  while planning); values missing from the list above fall back to drift.
- Whether a user-set `navigation.state` left at `moored` after leaving is
  trusted as decided; this plan trusts it, as decision 17 says.
- Overlay: the issue offered a stationary footprint as a second overlay;
  not decided, so the overlay stays combined. Ask before adding one.
- #13 depends on `mode.current()`; whichever lands first defines it.
- #19: coverage exports carry the mode per cell (a `mode` column in CSV,
  field in JSON); the anonymise switch does not affect it.
- #20: the map mode selector follows the live control pattern from #20 but
  is a view choice only and is never saved; the drift thresholds stay in
  the server config form.
