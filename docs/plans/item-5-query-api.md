# Implementation Plan: roadmap item 5, query layer and REST API

## Overview
Read the published counters back through the History API, answer windowed
queries, and serve them on read-only routes.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 6.1, 6.2 and 8; ARCHITECTURE 2.7 to 2.9; docs/findings.md (History
API).

## Approach
- `HistoryApiReader` uses `app.getHistoryApi()` (the server's default
  provider, in process) with `Temporal.Instant` ranges, always passes a
  resolution, uses only `last` and `max`, and splits requests into 40 paths.
  Without `getHistoryApi` or a provider the null reader puts the plugin in
  live-only mode.
- `increments()` turns a `last` series into per-bucket increments: leading
  nulls count as zero, later nulls as unchanged, a drop is a restart from
  zero. Window totals and window histograms are sums of increments.
- Summary windows use 60 s, 300 s or 3600 s buckets, fine enough to see a
  restart. The one-hour window comes from the live minute buckets once the
  plugin has run an hour, since they are exact.
- The radar's p99 per sector is the `max` of the rolling one-hour p99 gauge
  over the window (SPEC 2.6). Distance series come from the bin counters,
  not from the gauges.
- Unique vessels for windows up to 24 hours come from the live registry;
  longer windows return null and the app shows the `vessels` series.
- Without history, everything comes from the aggregator's minute and hour
  buckets (up to 24 hours).

## Test Strategy
An in-process fake History API (`test/fixtures/history.ts`) that mimics
the recorded provider behaviour. A simulated plugin publishes every minute
for five hours, restarts with fresh counters and runs five more; the 24 h
summary must count every message exactly once. Live-only answers, route
registration with and without `router.access`, and 400 responses for bad
parameters.

## Implementation Steps
- [x] `history.ts`, `query.ts`, `api.ts`
- [x] Tests

## Files to Create/Modify
`src/history.ts`, `src/query.ts`, `src/api.ts`, test fixtures and tests.

## Open Points
SPEC 13.1: the restart detection is tested against the fake; the spike on
the development server checks it against a real provider. A restart whose
new counter overtakes the old value within one bucket is not detectable;
with 60 s to 3600 s buckets and a counter starting from zero this needs
more traffic in one bucket than in the whole previous run.
