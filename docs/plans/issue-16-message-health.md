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
  duplicate detector and the jump tracker. It is one instance per plugin,
  not per ingest: `plugin.ts` creates one `Ingest` and one `N2kIngest` per
  event, so only a shared detector sees the copies a receiver sends to two
  events. `onInput` passes every decoded message, with the name of the
  event it came on, to `health.check(msg, event, shipType, time)`, which
  returns what it found; the aggregator then counts the message as today
  and bumps the health counters from that verdict. The aggregator,
  coverage and long-range log are unchanged in what they count.
- **Health counts live in the aggregator.** `Counts` gains a `health`
  record, so the totals, the minute ring and the hour ring carry it and
  live-only windows work like every other count. Decode errors and
  incomplete messages are taken from the ingest stats: `onInput` compares
  them before and after each push and counts the difference at that time.
- **Reported SOG (C4).** Both decoders already deliver it: ggencoder sets
  `sog` in knots (types 1 to 3, 9, 18, 19, 27) and canboatjs puts `sog` in
  metres per second in the PGN fields. `AisMessage` gains `sogMps`, filled
  by both inputs, without the "not available" value (1023, which is 102.3
  kn, or 1023 kn for message 9) and negative or non-finite values.
- **Duplicates (decision 13, C1, C1a).** Key: MMSI and message type; type
  24 adds the part (A carries a name, B a ship type) so the two halves of
  one static report are not duplicates of each other. A message is a
  duplicate when a message with the same key and a position within 2e-5
  degrees (about 2 m, so the two decoders' rounding cannot split a pair)
  was seen less than 2 s earlier, fixed. Messages without a position match
  on the key alone. Two counters: same event (one receiver repeating
  itself, or two receivers on one event) and cross event (the same message
  on two configured events). Recent messages are pruned once a second, so
  the detector holds only the last 2 s. Duplicates are still counted
  everywhere else.
- **Invalid positions.** A position report (types 1, 2, 3, 9, 18, 19) that
  reaches the aggregator without `lat`/`lon` had them out of range or at
  the "not available" values 91/181; both decoders already drop those
  fields, so counting in the aggregator is decoder independent.
- **Own position missing.** Position reports with a valid position counted
  while own position is unknown or stale (SPEC 2.2), so a gap in distance
  figures is explained. Counted in the aggregator's `add`.
- **Implausible jumps (decision 16, C5).** The tracker keeps an anchor per
  MMSI: a position and its time (pruned after `targetExpirySeconds`, capped
  at `MAX_VESSELS`). When a report lies at least 500 m from the anchor and
  at least 1 s later, the implied speed is distance over time; the report
  becomes the anchor. A report closer than 500 m replaces the anchor only
  once the anchor is older than 60 s. So a fast vessel reporting every 2 s
  is measured over about 500 m (the gap between two reports alone would be
  tens of metres), GPS jitter never counts, and a bogus position is judged
  against a position at most a minute or one reporting interval old. Above
  the sender's limit the jump counter goes up; one bogus position counts
  as two jumps (out and back), which SPEC states. Limits, all settings:
  60 kn normal, 120 kn for ship types 20 to 29 (WIG) and 40 to 49
  (high-speed craft, including hovercraft ferries), 600 kn for message 9
  (SAR aircraft). Vessels whose type is not yet known use the normal limit.
  Ship type comes from the aggregator's vessel registry.
- **Fastest vessels.** Per UTC day, the highest implied speed of each MMSI,
  capped at the 20 fastest, kept by `LongRangeLog` in the same daily file
  (decision 16: no new kind of state). Ranked by implied speed (chosen by
  the maintainer), with the reported SOG of the later report beside it
  (C4). An entry: `time`, `mmsi`, `name?`, `cls`, `shipType?`, `speedMps`,
  `sogMps?`, `limitMps`, `implausible`, `gapS`, `fromLat`, `fromLon`,
  `lat`, `lon`. Names are filled in by the existing `enrich`. Implausible
  entries stay in the list and are marked, so a bogus jump can be told
  from a fast ferry, like far entries in the farthest list.
- **File schema.** `longrange-YYYY-MM-DD.json` becomes `version: 2` with a
  `fastest` array beside `entries`. A version 1 file (or one with no or a
  malformed `fastest`) loads with an empty list; each entry is checked
  with an `isFastEntry` guard like `isEntry`. Version 1 code reading a
  version 2 file uses `entries` and ignores `fastest`, so a downgrade
  keeps the farthest list. About 6 KB more per day at the cap.
- **Paths** (in `src/paths.ts` only), cumulative counters published at each
  interval: `health.decodeErrors`, `health.incomplete`, `health.duplicates`,
  `health.duplicatesCrossEvent`, `health.positionInvalid`,
  `health.implausibleJumps`, `health.noOwnPosition`. 7 more paths per
  interval. Shares over a window use `last` and `max` differences like the
  other counters; the denominator is `messages.total` plus `decodeErrors`
  and `incomplete`.
- **REST.** `/series` gains `metric=health` (each counter per bucket and
  the denominator); `/summary` gains a `health` object (the counts and the
  received total for the window); `/longrange` gains `fastest`, the 10
  fastest in the window, so no new route. The class A/B mix needs no paths:
  the web app derives it from the `positions` series.
- **Web app.** Overview: one line with the good-message share, and a hint
  when duplicates exceed 20 percent of messages ("one receiver may reach
  two configured events"), no notification (decision 14). The hint counts
  same-event duplicates, and cross-event ones too while per-source
  statistics (#14) are off, which is always until #14 lands (C1a). Charts:
  a health chart of shares per bucket and the class A/B mix as a share.
  Sectors page: a "Fastest vessels" table below the farthest receptions
  table, implausible rows marked, implied speed and reported SOG side by
  side.
- **Config** (server config form, basic settings per #20 decision 25):
  `jumpSpeedLimitKnots` 60, `jumpSpeedLimitHighSpeedKnots` 120 (ship types
  20 to 29 and 40 to 49), `jumpSpeedLimitAircraftKnots` 600 (message 9).
  The 2 s duplicate window and 20 percent hint are fixed. Knots in the
  form, metres per second internally and in REST.

Rejected: a payload hash as the duplicate key (NMEA 0183 and NMEA 2000
copies differ in form); rounding positions for the key (two decoders can
round one position to neighbouring steps); dropping duplicates or jumps
(SPEC 2.3); the gap between consecutive reports as the speed baseline (a
fast vessel moves tens of metres between reports, below the jitter floor);
ranking the fastest list by reported SOG (the implied speed is what tells a
bogus jump apart; chosen by the maintainer).

## Test Strategy
Unit tests, synthetic MMSIs (999xxxxxx for vessels, 111999xxx for SAR
aircraft), positions from the existing fixtures, the in-process history
fake. SOG from sentences and PGNs, not-available values dropped. Duplicate
detector: same message from an NMEA 0183 sentence and a canboat PGN
fixture within 2 s counts once, at 2.1 s none, different type or position
none, messages without position, type 24 parts A and B, same and cross
event counters. Invalid positions: 91/181 and
out-of-range sentences and PGNs. Jumps: normal, WIG, HSC, message 9 and
unknown-type limits, jitter below 500 m, out-and-back counts two. Fastest
list: cap, one per MMSI, names enriched, day change. File: version 1
fixture loads with empty `fastest`, malformed entries skipped, round trip.
Paths published, shares from history, `/longrange` and `/summary` shapes,
web share and hint helpers.

## Implementation Steps
- [ ] SOG in both inputs
- [ ] Paths, metadata and config options with defaults
- [ ] `health.ts`: counters, duplicate detector, jump tracker (tests first)
- [ ] `noOwnPosition` in aggregator totals; wiring in `plugin.ts`, publish
- [ ] Long-range file version 2 with `fastest`, loader for version 1
- [ ] Query: `health` series and summary; `/longrange` `fastest`
- [ ] Web: overview line and duplicate hint, health and A/B mix charts,
      fastest table on the sectors page, checked at phone width
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
- Dependencies: #14 adds per-source health on top of the event label
  `health.check` takes, and its per-source switch decides whether
  cross-event duplicates still feed the hint (C1a); #20 documents the
  paths in `docs/paths.md`. Neither blocks this issue.
- A high-speed craft or WIG craft is judged by the normal limit until its
  message 5 or 24 is heard, so a few jumps can be counted early in a
  session. Accepted as a count-only artefact; documented in SPEC 2.8.
- Whether ggencoder and canboatjs both leave out 91/181 rather than
  passing other sentinel values is assumed from the range check; the
  tests with both fixtures confirm it.
- Default limits (60, 120, 600 kn) confirmed by the maintainer (C5).
