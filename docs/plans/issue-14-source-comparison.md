# Implementation Plan: #14 antenna and receiver comparison

## Overview
Tell whether an antenna, cable, splitter or receiver change helped. Two
parts that can ship separately: a compare view that puts two date windows
side by side from data the plugin already keeps, and opt-in statistics per
server event (`nmea0183`, `N2KAnalyzerOut`, ...) with per-source message
health from #16. Decisions 5 to 8 and 15 of the 1.0.0 planning apply.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 2.3 (distance bins), 4.1, 5 (sources, double counting), 6.1, 6.2, 7,
8, 9, 12 (lean history, counters, configurable events). ARCHITECTURE 2.1,
2.4, 2.8, 2.9, 2.11, 5 (event subscription), 7, 9 (multiple sources).

## Approach
- **Compare (part 1).** A `#/compare` view with a date and a length
  (default 7 days before and 7 days after the date, each window at most
  7 days, per the lean history decision) and a source picker (`all`, or a
  source when per-source statistics are on). Per window it shows messages,
  positions by class, distance avg, median, p95, p99 (max marked
  untrusted), the sectors view and the coverage area, side by side with the
  difference. `/summary` and `/sectors` accept `from` and `to` (ISO, whole
  hours) as an alternative to `window`; `/coverage` accepts `from` and `to`
  as UTC days and reads only the daily files (`Coverage.footprintRange`).
  Sectors view and coverage stay combined; per-source compare is the summary
  figures only. Unique vessels stay null beyond 24 h (SPEC 6.1). Coverage
  reaches back only `coverageRetentionDays` (14 by default, so 7 + 7 days
  fits only when the after window ends today); the view says so instead of
  showing a smaller area as a result. View state lives in the hash
  (`#/compare?date=YYYY-MM-DD&days=7&source=all`), not in the plugin
  config, so it needs no #20 save route. Change markers come later.
- **Per-source statistics (part 2).** New option `sourceStatistics`
  (boolean, default `false`). `src/sources.ts` holds a `SourceStats` per
  configured event: cumulative counters (messages, positions classA,
  classB, other, 32 distance bins), a 24 hour ring of hour buckets for
  live-only answers, and the event's `IngestStats` plus the #16 health
  counters. `plugin.ts` already gives each event its own listener and
  decoders, so the closure passes the event name; after `agg.add` the same
  message and its `Located` result go to that source. The main aggregator
  is unchanged: nothing is filtered, and a receiver on two events still
  counts twice in the main figures (SPEC 5). Labels are event names only,
  no user names (decision 7).
- **Paths.** Only in `src/paths.ts`: `sourceLabel(event)` keeps
  `[A-Za-z0-9]`, maps every other character to `_` (empty becomes `_`),
  and resolves collisions after mapping with `_2`, `_3` in config order,
  logged once. Counters under `sensors.ais.statistics.sources.<label>.`:
  `messages.total`, `positions.classA|classB|other`, `distance.bin.<nn>`
  (36 per source), plus the per-source health counters #16 defines. No
  per-source gauges: window avg, median, p95 and p99 come from the summed
  bin increments, as for the main statistics (decision 6). Published at
  every publish interval with the other counters, read with `last` and
  `max` with the same reset detection.
- **History load.** Main paths today at the 5 minute default: about 59
  per tick (16,990 rows a day) plus 144 hourly sector paths (3,460), about
  20,400 rows a day. Each source adds 36 x 288 = 10,370 rows a day, so the
  default two events about double the load (plus health counters). That is
  why it is opt-in and the option description states it. A 7 day compare
  window reads 36 counters x 2 aggregates per window at 3600 s, in 40 path
  chunks, one request at a time, cached for a minute.
- **REST.** `/summary?source=<label>` for a source; `/sources` lists
  labels, event names and live health; `/status` gains a per-source health
  block. All routes stay read-only (`router.access('readonly')`).

Rejected for now: per N2K `src` split (decision 5, later), user source
names (decision 7), the overlap figure from the issue and per-source
sectors, cells or vessels (not in decision 6; each adds paths or state).

## Test Strategy
Unit tests with synthetic MMSIs (999xxxxxx), the sentence builder and PGN
fixtures in `test/fixtures/`, and the in-process History API fake:
`sourceLabel` mapping and collisions; `SourceStats` counts on two fake
events while the main totals still double count; option off publishes no
source paths; publish builds 36 paths per source; query window figures
per source from history and live, including a counter reset;
`from`/`to` validation (whole hours, at most 7 days, from before to);
`footprintRange` over day files including missing days; compare route
helpers and the web route in `test/web/route.test.ts`.

## Implementation Steps
- [x] Ask the maintainer the open points below, then start with part 1
      (2026-11-01: part 1 ships as its own PR first; sectors and coverage
      stay combined, per-source compare is the summary figures only)
- [x] Part 1: `from`/`to` in query and routes, `footprintRange`, compare view
- [x] Part 1 docs: SPEC 6.1, 7; ARCHITECTURE 2.5, 2.8, 2.9, 2.11; README; CHANGELOG
- [ ] Part 2: config option, `sourceLabel` and source paths, `SourceStats`, wiring
- [ ] Part 2: publish, query, `/summary?source=`, `/sources`, `/status`, picker
- [ ] Part 2: per-source health with #16
- [ ] Tests first for each part, committed separately
- [ ] Part 2 docs: SPEC 4.1, 5, 6.1, 6.2, 8 (history load), 9, 12 (new
      decision entry); ARCHITECTURE 2.4, 2.8, 5, 7, 9 (per event done, per
      `src` later); README status and features; `docs/paths.md` from #20

## Files to Create/Modify
src/paths.ts, src/config.ts, src/sources.ts (new), src/plugin.ts,
src/publish.ts, src/query.ts, src/coverage.ts, src/api.ts, web/src/route.ts,
web/src/compare.ts (new), web/src/main.ts, web/src/api.ts,
web/static/style.css, test/sources.test.ts (new), test/paths.test.ts,
test/config.test.ts, test/publish.test.ts, test/query.test.ts,
test/api.test.ts, test/coverage.test.ts, test/plugin.test.ts,
test/web/route.test.ts, SPEC.md, ARCHITECTURE.md, README.md, CHANGELOG.md.

## Open Points
- **#16 duplicates on two receivers.** Decision 13 keys duplicates on MMSI,
  type and position within 2 s, decoder independent. Two different
  antennas hearing the same transmission produce exactly that, so a
  healthy two-receiver setup trips the 20 percent hint (decision 14).
  Decided after review: #16 counts same-event and cross-event duplicates
  apart; cross-event duplicates count toward the hint only while
  `sourceStatistics` is off, and are shown as receiver overlap when it is
  on. This issue only adds the per-source split of those counters.
- **Dependencies.** #16 supplies the health counters this splits per
  source. #13 alerts stay on the combined figures. #17 mode-split coverage
  is not filtered in compare (decision 19). #19 export should include the
  per-source counters. #20 lists `sourceStatistics` in the server config
  form only and documents the source paths in `docs/paths.md` without a
  stability promise.
- In live-only mode compare can only answer windows inside the last 24
  hours of hour buckets; older windows show "no history" rather than zero.
- Renaming an event in `sentenceEvents` starts a new label and path set;
  the old series stay in history under the old label.
