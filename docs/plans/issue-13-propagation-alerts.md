# Implementation Plan: #13 propagation alerts

## Overview
Raise a SignalK notification while reception range is well above normal, as
in a tropospheric ducting or sporadic E opening, so the crew can watch it
live instead of finding it in the long-range log the next day. Decisions by
the maintainer on 2026-11-01 (issue comment, 1.0.0 decisions 1 to 4).

## Relevant SPEC/ARCHITECTURE Sections
SPEC 1.2 (range varies with conditions), 2.3 (no filtering, untrusted max),
2.6 and 2.7 (sector maxima and the long-range log), 4.1, 4.2, 6.1, 6.2, 7,
8, 9, 12. ARCHITECTURE 2.4 (Aggregator), 2.6 (Publisher), 2.8 (Query
layer), 2.9 (REST), 2.11 (Web app), 5, 7.

## Approach
- **Baseline (decision 1).** The median of the hourly p99 over the last 7
  days. Taken from `Query.series('distance', 3600, now - 7d, now)`, which
  already derives hourly p99 from the distance bin counters with `last` and
  `max` only; recomputed once an hour in the hourly job, not per check.
  Only hours with at least 20 position reports count (the sectors view's
  `MIN_SECTOR_REPORTS` reasoning: sparse hours land on bin edges). Live-only
  mode uses the aggregator's hour buckets, so at most 24 hours. Alerts stay
  unarmed until 24 qualifying hours exist. No time-of-day baseline.
  Rejected: storing hourly p99 values in the daily files (history already
  holds the bin counters, and the files stay the only owned state as they
  are).
- **Trigger (decision 2).** Every minute a pure `PropagationDetector`
  (`src/propagation.ts`, clock injected) checks two conditions on a fixed
  15 minute window: the p99 of the merged minute buckets is at least
  `propagationFactor` times the baseline, and at least
  `propagationMinVessels` distinct MMSIs had a position beyond the baseline
  distance. The alert fires once both have held at every check for
  `propagationSustainMinutes`, and clears once they have been false for the
  same time (hysteresis by time, no second threshold). The max is never
  used, so one bogus position cannot fire it.
- **Vessels beyond baseline.** The detector receives each `Located` from
  `plugin.ts` beside `longRange.add`, keeping per MMSI the farthest distance
  and bearing in the window (pruned by time, capped like the vessel
  registry). It is a side view; the aggregator is unchanged and drops
  nothing (SPEC 2.3).
- **Notification (decision 3).** `notifications.sensors.ais.statistics.propagation`
  with `state` from `propagationNotificationState` (default `warn`) and
  `method` from `propagationNotificationMethods` (default `['visual']`).
  The message names the short-window p99, the baseline, the ratio, the
  vessel count and the sectors (`sectorLabel`) the far vessels came from.
  On clear and on stop the plugin publishes `state: 'normal'`.
- **Underway (decision 4).** `propagationSuppressUnderway` (default true)
  suppresses the notification while #17 reports `underway`; the detector
  keeps evaluating, and an active alert is cleared when the boat gets
  underway. Mode `unknown`, or #17 not yet merged, does not suppress.
- **Gauge.** `propagation.ratio` (short-window p99 over baseline, unitless)
  goes out at each publish interval, left out while there is no baseline,
  so history and #19 exports show openings over time.
- **REST and web app.** `GET /propagation` (readonly, cached a minute like
  the other data routes) returns `state` (`normal`, `alert`, `suppressed`,
  `unarmed`), `ratio`, `p99M`, `baselineM`, `baselineHours`, `vessels`,
  `sectors` and `since`. The web app adds the notification path to its one
  WebSocket subscription and shows a banner in the shell, under the offline
  banner, linking to `#/sectors` where the long-range table lists the entries
  behind it.

## Test Strategy
Unit tests with synthetic MMSIs (999xxxxxx), positions from the existing
fixtures and the in-process History API fake: baseline from history and
from live buckets, the 20 report rule and the 24 hour arming; firing only
after the sustain time and clearing after it; one vessel with a bogus far
position never fires; two vessels below the minimum never fire; underway
suppression and `unknown` mode; config defaults and clamping; the delta
shape and `normal` on stop; the ratio path; the route; the banner helper
under `test/web`.

## Implementation Steps
- [x] Paths in `src/paths.ts`: `propagationRatio` and the notification path
- [x] Config options, schema and `resolveConfig` clamping
- [x] `src/propagation.ts`: detector, baseline helper, per-MMSI window
- [x] Wiring in `plugin.ts` (minute timer, hourly baseline, stop), publish, metadata
- [x] `GET /propagation`, web banner and WebSocket path
- [x] Live settings for factor, vessels and duration, with a trial replay
  of the last hour of checks on the sectors page
- [x] Tests (separate commit), docs, CHANGELOG
- [x] Pass the #17 mode (`VesselMode.current`) to the detector

## Files to Create/Modify
src/propagation.ts (new), src/paths.ts, src/config.ts, src/plugin.ts,
src/publish.ts, src/query.ts (baseline helper), src/api.ts,
web/src/signalk.ts, web/src/api.ts, web/src/main.ts, web/static/style.css,
test/propagation.test.ts (new), test/config.test.ts, test/api.test.ts,
test/plugin.test.ts, test/web, SPEC.md, ARCHITECTURE.md, README.md,
CLAUDE.md (current state), CHANGELOG.md, docs/paths.md once #20 adds it.

New options (SPEC 9): `propagationAlerts` true; `propagationFactor` 2
(1.2 to 10); `propagationMinVessels` 3 (at least 1);
`propagationSustainMinutes` 15 (1 to 60); `propagationNotificationState`
`warn` (`alert`, `warn`, `alarm`, `emergency`);
`propagationNotificationMethods` `['visual']` (`visual`, `sound`);
`propagationSuppressUnderway` true.

Docs in the same change: SPEC new 2.8 (propagation rule), 4.1 (ratio
gauge), 4.2 (detector window and alert state, in memory only), 6.1
(route), 6.2 (ratio path and the notification path as the one non-numeric,
non-statistics output), 7 (banner), 8 (nothing new persisted), 9 (options),
12 (decision entry). ARCHITECTURE 2.x (detector), 2.6, 2.9, 2.11, 5
(notifications), 7. README "What it does".

Dependencies: #17 provides the mode (an injected `mode()` returning
`stationary`, `underway` or `unknown`). #20: the factor, the vessel count
and the sustained minutes are live settings (maintainer, after review): they
join `LIVE_SETTINGS`, get web app controls next to the alert banner, and are
saved through the #20 admin/readwrite-gated save button. The other alert
options stay in the server config form, and the #20 save route must merge
into the stored config so it never drops them. #14: combined range only; per-source alerts
are not planned. #16: its counters do not feed the trigger; the distinct
vessel rule already covers a single jumping vessel. #19: the ratio series
is exportable like any path.

## Open Points
Answered by the maintainer on 2026-11-01, after this plan was written:
- On/off switch: yes, `propagationAlerts`, off by default.
- Clearing: once the conditions failed for the sustain time, no second
  threshold.
- Window: a setting of its own, `propagationWindowMinutes`, default 15
  (5 to 60).
- Display check in the admin UI, Freeboard-SK and KIP: skipped for now,
  listed in SPEC 13.
- Live controls: factor, vessel count and duration join `LIVE_SETTINGS`
  (decision C2); the web app tries them by replaying the last 60 checks
  from `GET /propagation`, so no trial query parameter is needed.

With `coverageRetentionDays` below 7 nothing changes, since the baseline
comes from history; with a provider retention under 7 days the baseline
covers what history holds.
