# Implementation Plan: #16 message health

## Overview
Report the quality of what the receiver decodes, not only how much: shares
of undecodable, incomplete, duplicate and invalid-position messages,
implausible position jumps, the class A/B mix over time, and a short list
of the fastest vessels of the day. Health counters only count; nothing is
removed from distance, sectors or coverage (SPEC 2.3). Part of 1.0.0.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 2.3 (bogus positions), 2.7 (long-range log), 4.1, 4.2, 5, 6.1, 6.2,
7, 8, 9, 10.2 (speed filter, deferred) and 12 (configurable events, keep
everything). ARCHITECTURE 2.1, 2.4, 2.5a, 2.6, 2.8, 2.9, 2.11 and 7.

## Approach
- **Health module.** A pure, clock-injectable `src/health.ts` holds the
  health counters, the duplicate detector and the jump tracker. It is one
  instance per plugin, not per ingest: `plugin.ts` creates one `Ingest`
  and one `N2kIngest` per event, so only a shared detector sees the
  copies a receiver sends to two events. `onInput` passes every decoded
  message to `health.add(msg, shipType, time)` and then to the aggregator
  as today; the aggregator, coverage and long-range log are unchanged in
  what they count. The `add` signature takes an optional source label so
  #14 can key the same counters per event later (decision 15).
- **Duplicates (decision 13).** Key: MMSI, message type and position
  rounded to 1e-5 degrees (about 1 m, coarser than the AIS 1/10000 minute
  step and the canboat 1e-7 step, so both decoders key alike). Messages
  without a position (5, 24 and others) key on MMSI and type alone. A
  message is a duplicate when the same key was seen less than 2 s earlier
  (fixed, not a setting). Entries older than 2 s are dropped on each add,
  so the map stays small. Duplicates are still counted everywhere else.
- **Invalid positions.** A position report (types 1, 2, 3, 9, 18, 19) that
  reaches the aggregator without `lat`/`lon` had them out of range or at
  the "not available" values 91/181; both decoders already drop those
  fields, so counting the missing fields is decoder independent and needs
  no change in `ingest.ts` or `n2k.ts`.
- **Own position missing.** Position reports counted while own position is
  unknown or stale (SPEC 2.2), so a gap in distance figures is explained.
  Taken from the aggregator's `add` path (it already knows), exposed as a
  counter in `totals`.
- **Implausible jumps (decision 16).** The tracker keeps the last position
  and time per MMSI (pruned after `targetExpirySeconds`, capped at
  `MAX_VESSELS`). For each position report it computes the implied speed
  from the previous one, only when the two are at least 500 m apart and
  1 s apart (constants), so GPS jitter and quantisation never count. Above
  the sender's limit the jump counter goes up; the new position always
  becomes the last one, so one bogus position counts as two jumps (out and
  back), which SPEC states. Limits: message 9 uses the aircraft limit;
  ship types 20 to 29 (WIG) and 40 to 49 (high-speed craft, including
  hovercraft ferries) use the high-speed limit; everything else, including
  vessels whose type is not yet known, uses the normal limit. Ship type
  comes from the aggregator's vessel registry (`agg.vessel(mmsi)`).
- **Fastest vessels.** Per UTC day, the highest implied speed of each MMSI
  (same 500 m baseline), capped at the 20 fastest, kept by `LongRangeLog`
  in the same daily file (decision 16: no new kind of state). An entry:
  `time`, `mmsi`, `name?`, `cls`, `shipType?`, `speedMps`, `limitMps`,
  `implausible` (speed above the limit), `gapS`, `fromLat`, `fromLon`,
  `lat`, `lon`. Names are filled in by the existing `enrich`. Implausible
  entries stay in the list and are marked, so a bogus jump can be told
  from a fast ferry, like far entries in the farthest list.
- **File schema.** `longrange-YYYY-MM-DD.json` becomes `version: 2` with a
  `fastest` array beside `entries`. A version 1 file (or one with no or a
  malformed `fastest`) loads with an empty list; each entry is checked
  with an `isFastEntry` guard like `isEntry`. Version 1 code reading a
  version 2 file uses `entries` and ignores `fastest`, so a downgrade
  keeps the farthest list. About 4 KB more per day at the cap.
- **Paths** (in `src/paths.ts` only), cumulative counters published at each
  interval: `health.decodeErrors`, `health.incomplete`, `health.duplicates`,
  `health.positionInvalid`, `health.implausibleJumps`,
  `health.noOwnPosition`. `decodeErrors` and `incomplete` are the sums of
  the ingest stats, which already exist and reset with the process like
  every other counter. 6 more paths per interval. Shares over a window use
  `last` and `max` differences like the other counters; the denominator is
  `messages.total` plus `decodeErrors` and `incomplete`.
- **REST.** `/series` gains `metric=health` (each share per hour);
  `/summary` gains a `health` object (good-message share and each share
  over the window); `/longrange` gains `fastest`, the 10 fastest in the
  window, so no new route. The class A/B mix needs no paths: the web app
  derives it from the `positions` series.
- **Web app.** Overview: one line with the good-message share over 24 h,
  and a hint when duplicates exceed 20 percent of messages ("one receiver
  may reach two configured events"), no notification (decision 14).
  Charts: a health chart of shares per hour and the class A/B mix as a
  stacked share. Radar page: a "Fastest vessels" table next to the
  farthest receptions table, implausible rows marked.
- **Config** (server config form, basic settings per #20 decision 25):
  `jumpSpeedLimitKnots` 60, `jumpSpeedLimitHighSpeedKnots` 120 (ship types
  20 to 29 and 40 to 49), `jumpSpeedLimitAircraftKnots` 600 (message 9).
  The 2 s duplicate window and 20 percent hint are fixed. Knots in the
  form, metres per second internally and in REST.

Rejected: a payload hash as the duplicate key (NMEA 0183 and NMEA 2000
copies differ in form); dropping duplicates or jumps (SPEC 2.3); reported
SOG for the fastest list (not decoded today, and the implied speed is
what tells a bogus jump apart).

## Test Strategy
Unit tests, synthetic MMSIs (999xxxxxx for vessels, 111999xxx for SAR
aircraft), positions from the existing fixtures, the in-process history
fake. Duplicate detector: same message from an NMEA 0183 sentence and a
canboat PGN fixture within 2 s counts once, at 2.1 s none, different type
or position none, messages without position. Invalid positions: 91/181 and
out-of-range sentences and PGNs. Jumps: normal, WIG, HSC, message 9 and
unknown-type limits, jitter below 500 m, out-and-back counts two. Fastest
list: cap, one per MMSI, names enriched, day change. File: version 1
fixture loads with empty `fastest`, malformed entries skipped, round trip.
Paths published, shares from history, `/longrange` and `/summary` shapes,
web share and hint helpers.

## Implementation Steps
- [ ] Paths, metadata and config options with defaults
- [ ] `health.ts`: counters, duplicate detector, jump tracker (tests first)
- [ ] `noOwnPosition` in aggregator totals; wiring in `plugin.ts`, publish
- [ ] Long-range file version 2 with `fastest`, loader for version 1
- [ ] Query: `health` series and summary; `/longrange` `fastest`
- [ ] Web: overview line and duplicate hint, health and A/B mix charts,
      fastest table on the radar page, checked at phone width
- [ ] Docs: SPEC 2.3, new 2.8 Message health, 2.7, 4.1, 4.2, 6.1, 6.2, 7,
      8, 9, 10.2 (speed filter replaced by the count-only counter), 12 (new
      decision; the configurable events entry now names the duplicate
      counter); ARCHITECTURE 2.1, new 2.4a Health, 2.5a, 2.6, 2.8, 2.9,
      2.11, 7; README "What it does"; `docs/paths.md` (#20); CHANGELOG

## Files to Create/Modify
src/health.ts (new), src/paths.ts, src/config.ts, src/aggregate.ts,
src/publish.ts, src/plugin.ts, src/longrange.ts, src/query.ts, src/api.ts,
web/src/api.ts, web/src/main.ts, web/src/charts.ts, web/static/style.css,
test/health.test.ts (new), test/fixtures (version 1 long-range file),
existing tests for publish, longrange, query and api, SPEC.md,
ARCHITECTURE.md, README.md, CHANGELOG.md.

## Open Points
- Dependencies: #14 adds per-source health on top of the source label
  `health.add` takes; #20 documents the six paths in `docs/paths.md`
  (without a stability promise) and decides whether the jump limits get
  live controls in the web app. Neither blocks this issue.
- A high-speed craft or WIG craft is judged by the normal limit until its
  message 5 or 24 is heard, so a few jumps can be counted early in a
  session. Accepted as a count-only artefact; documented in SPEC 2.8.
- Whether ggencoder and canboatjs both leave out 91/181 rather than
  passing other sentinel values is assumed from the range check; the
  tests with both fixtures confirm it.
- Default limits (60, 120, 600 kn) are a proposal for the maintainer to
  confirm before implementation.
