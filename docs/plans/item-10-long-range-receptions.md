# Implementation Plan: long-range receptions (0.4.0)

## Overview
Rare long-range receptions (sporadic-E, tropospheric ducting, or bogus
positions) are counted but invisible since 0.3.2, because the radar radius
skips sector-hours with fewer than 20 reports. Show them without inflating
the radius: a per-sector maximum drawn as a thin long tick on the radar, and
a log of the farthest receptions. Requested by the maintainer.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 2.6 (sectors), 6.1 (REST), 6.2 (paths), 6.3 (overlay), 7 (web app),
8 (state), 12 (decisions). ARCHITECTURE 2.4 to 2.10.

## Approach
- **Sector maxima.** Buckets keep the farthest distance per class and
  sector, and when it was received. A new gauge path per sector and class,
  `sectors.<deg>.<cls>.max` in metres, goes out hourly with the other
  sector paths (48 more values an hour). The radar answer gains `maxM` and
  `maxAt` per sector: exact time from live buckets or a matching log entry,
  otherwise the start of the history hour (`maxHour`).
- **Display.** Web radar: a thin radial tick from the wedge edge (or the
  centre when there is no radius) to the maximum, clipped at the rim when it
  is beyond the scale, with a wide invisible hit line for hover text with
  distance and time. Map and plotter overlay: a `radar-max` line feature
  along the sector's centre bearing with the same properties.
- **Long-range log.** Per UTC day, the farthest reception of each MMSI,
  capped at the 50 farthest, in `longrange-YYYY-MM-DD.json` beside the
  coverage files, written hourly and on stop and pruned with
  `coverageRetentionDays`. An entry holds time, MMSI, vessel name when
  known, class, ship type, distance, bearing, the remote position and the
  own position at reception. Names come from message 5, 19 and 24 part A
  and the matching NMEA 2000 PGNs, kept in the vessel registry; a missing
  name is filled in when it becomes known that day.
- **REST.** `GET /longrange?window=24h|7d` returns the 25 farthest entries.
  The radar page shows them as a table below the two radars.
- **All cells.** `GET /coverage?all=true` adds the cells beyond the
  distance cap, marked `capped`; the map draws them dashed behind an "All
  cells" toggle, off by default. Requested by the maintainer with this item.

Rejected: publishing the time of the maximum as a numeric path (an epoch
in a history provider is awkward to read); per-hour log entries per sector
(about 1,100 entries a day for exact times the log usually has anyway).

## Test Strategy
Unit tests with synthetic MMSIs (999xxxxxx), positions from the existing
fixtures, and the in-process history fake: bucket maxima and merge, the new
paths published hourly, radar maxima from live and history with times, log
keeping one entry per MMSI and the cap, files written, read and pruned, name
decoding for both inputs, the route, overlay features and the web radar
geometry helpers.

## Implementation Steps
- [x] Names in ingest (ggencoder and N2K) and the vessel registry
- [x] Bucket sector maxima, path, publish, metadata
- [x] Long-range log module, wiring, route
- [x] Radar answer maxima, overlay and map features, web radar ticks, table
- [x] Tests, docs (SPEC, ARCHITECTURE, README, CLAUDE.md state rule), CHANGELOG 0.4.0

## Files to Create/Modify
src/ingest.ts, src/n2k.ts, src/aggregate.ts, src/paths.ts, src/publish.ts,
src/longrange.ts (new), src/query.ts, src/api.ts, src/plugin.ts,
src/overlay.ts, src/style.ts, web/src/api.ts, web/src/radar.ts,
web/src/main.ts, web/src/map.ts, web/static/style.css, tests, docs.

## Open Points
- Whether Freeboard-SK shows feature properties on hover for a data
  overlay is unverified; the tick draws either way.
