# Implementation Plan: #15 range vs weather

## Overview
Show hourly p99 reception range next to the weather the boat measures, so
ducting can be related to the conditions behind it (high pressure,
inversions, humid air over cold water). A Weather panel on the charts view
plots p99 range and one chosen weather series over the same window, plus a
scatter of the two with a Pearson r. The weather is read back through the
History API; the plugin publishes and stores nothing new. Decisions 9 to 12
and 25 of the 1.0.0 planning, and the maintainer's comment on #15.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 6.1 (REST), 7 (charts view), 8 (persistence, aggregates), 9
(configuration), 12 (decisions: History API only, serial requests and one
minute cache, 7 day windows). ARCHITECTURE 2.7 (HistoryReader), 2.8 (query
layer), 2.9 (REST), 2.11 (web app), 7 (file structure).

## Approach
- **Setting.** `weatherPaths: string[]`, default
  `environment.outside.pressure`, `environment.outside.temperature`,
  `environment.outside.relativeHumidity`, `environment.water.temperature`.
  Any numeric self-vessel path is accepted (decision 9). `resolveConfig`
  trims, drops duplicates and entries that are not dotted path names (no
  wildcards), and keeps at most 8, so the read stays one request (one
  chunk of the 40 path limit) and the selector fits a phone. A basic setting,
  so it lives in the server config form only (decision 25). The defaults
  live in `src/config.ts`, not `src/paths.ts`, since the plugin does not
  publish them.
- **Aggregate.** Weather is read with `average` at 3600 s, the hourly mean
  (maintainer, after review). This is a documented exception to the
  `last`/`max` rule, for the weather paths only: `Aggregate` in
  `src/history.ts` gains `average`, and CLAUDE.md, SPEC 8 and ARCHITECTURE
  2.7 say so in the same change. Only one provider (QuestDB) is known to
  accept `average`, so a weather read that fails with `average` is retried
  once with `last`, and the panel notes which one it shows. Counters keep
  using `last` and `max` only.
- **Query.** `Query.weather(from, to, now)` aligns `from` down to the hour,
  as `series` does, and calls `HistoryReader.series(weatherPaths,
  'average', from, to, 3600)`, retrying with `last` once if that fails and
  then staying with `last` until the plugin restarts. It returns
  `{ available: true, source: 'history', resolution: 3600, aggregate,
  times, series: [{ path, values }] }`, leaving out paths whose column is
  all null. Without a provider it returns `{ available: false }`; a failed
  read gives `historyError` and no series, as there is no live fallback
  (decision 10: no in-memory weather record).
- **REST.** `GET /weather?from=&to=` (read-only, through the same
  `router.access('readonly')` guard and `cachedRoute()`). The span must be
  at most 7 days (decision 12, `BadRequest` otherwise); resolution is fixed
  at 3600 s. SPEC 6.1 gains the row.
- **Range side.** The panel reuses the `/series?metric=distance` answer the
  charts view already loads, whose 24h and 7d resolution is 3600 s with the
  same `from` and `to`, and pairs `p99M` with the weather by bucket start
  time. No second range read.
- **Request budget.** Opening the charts view at 24h or 7d adds one history
  request (up to 8 paths, `average`, 24 or 168 buckets) to the four `/series`
  calls it makes today, which cost three requests for distance and one or
  two each for the others. Everything goes through the HistoryReader's
  serial queue, and the route answer is reused for 60 s per parameter set,
  so reloads within a minute cost nothing (SPEC 12, lean history).
- **Web app.** The panel appears only when `/status` reports history and
  `/weather` returns at least one series (decision 10); on the 1h window it
  shows a short note that it needs 24h or 7d. It has a series selector
  (remembered in `localStorage`, a per-viewer view choice), a time chart with
  p99 on the left axis and the weather series on a right axis, and a scatter
  of hourly p99 against that series with `r = 0.42 (n = 150)` beside it.
  Hours with fewer than 20 distance reports are left out of the scatter and
  r, the same minimum as the sectors view (`MIN_SECTOR_REPORTS`); the time
  chart still shows every hour, and nothing is dropped in the aggregator.
  When both `environment.outside.temperature` and
  `environment.water.temperature` have data, the selector also offers "Air
  minus water temperature", computed in the browser in display units, as
  a proxy for inversions over cold water.
  `Chart` gains an optional right axis whose scale spans the data's minimum
  to maximum (pressure near 101 kPa cannot start at zero); the scatter is a
  `ScatterChart` in the same build-once, update-attributes style. Pearson r
  is a pure helper over pairs where both values exist, shown only with at
  least 24 pairs, otherwise "too few hours". Weather units come from
  `displayUnits(path)` and the path's `meta.units`, extending `units.ts`
  beyond `m` and `m2`; a ratio such as relative humidity shows as percent.
- **Rejected:** publishing weather under `sensors.ais.statistics.*` (it is
  already on the server, and decision 10 says no new state); a server side
  join of range and weather (would repeat the distance bin reads); windows
  beyond 7 days (decision 12).

## Test Strategy
Unit tests with the in-process `FakeHistory` (`test/fixtures/history.ts`)
fed synthetic weather samples (for example a pressure ramp from 100000 to
102000 Pa); no real vessel data. `config.test.ts`: defaults, trimming,
duplicates, bad names, the cap of 8. `query.test.ts`: hour alignment, one
`last` request at 3600 s for all paths, all-null paths left out, no
provider, a failing provider. `api.test.ts`: span over 7 days and bad times
rejected, cache reuse, read-only registration. `test/web/stats.test.ts`:
Pearson r on known pairs (perfect positive, negative, constant series
giving no r), pairing by timestamp with nulls, the 24 pair minimum. Unit
helpers for Pa, K and ratio in `units.test.ts`. Manual: the panel on a dev
server with a provider that records the weather paths (ask the maintainer
which server), at phone width and offline.

## Implementation Steps
- [x] Tests for config, query, route and the web helpers (separate commit)
- [x] `average` in `Aggregate` (`src/history.ts`), weather reads only
- [x] `weatherPaths` in `src/config.ts` (schema, defaults, resolve)
- [x] `Query.weather` in `src/query.ts`, `/weather` in `src/api.ts`
- [x] Web: `Weather` type in `web/src/api.ts`, right axis in `charts.ts`,
      `scatter.ts`, `stats.ts`, units extension, panel in `main.ts`, styles
- [x] Docs in the same change: SPEC 6.1 (route), 7 (Weather panel), 8 (the
      provider's path filters must also record the weather paths; weather is
      read with `average`, falling back to `last`), 9 (`weatherPaths` row),
      12 (a "range vs weather, chosen by the maintainer" entry);
      ARCHITECTURE 2.7 (also reads the configured weather paths with
      `average`), 2.8, 2.9, 2.11 and 7 (new files); CLAUDE.md (the
      aggregate rule's exception); README "What it does" bullet; CHANGELOG

## Files to Create/Modify
src/config.ts, src/query.ts, src/api.ts, web/src/api.ts, web/src/charts.ts,
web/src/scatter.ts (new), web/src/stats.ts (new), web/src/units.ts,
web/src/main.ts, web/static/style.css, test/config.test.ts,
test/query.test.ts, test/api.test.ts, test/web/stats.test.ts (new),
test/web/units.test.ts, SPEC.md, ARCHITECTURE.md, README.md, CHANGELOG.md.

## Decisions on the open points (maintainer, 2026-11-01)
- **Aggregate:** hourly `average`, with a fallback to `last` for a provider
  that rejects it (C3 of the 1.0.0 planning).
- **Air minus water temperature:** yes, as one more series when both
  temperature paths have data.
- **Sparse hours:** hours with fewer than 20 reports stay out of the scatter
  and r (display only).
- **Limit of 8 paths:** yes.

## Remaining notes
- **Dependency on #20.** None hard: `weatherPaths` is a config form setting
  and the panel follows the charts window selector. The admin or readwrite
  gated save button does not cover the weather paths.
- Only one History API provider has been checked (docs/findings.md); that
  it records `environment.*` paths depends on its path filters, so the
  manual check needs a provider configured to keep them.
