# Implementation Plan: #19 export coverage and the long-range log

## Overview
Let users download the coverage cells and the long-range log, to open them in
a spreadsheet or QGIS and to compare stations with other users of the plugin.
Download only, read-only routes, no import (maintainer decisions 20 to 23 on
#19). Part of 1.0.0.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 2.4 (coverage and its cap), 2.7 (long-range log), 6.1 (REST, read-only
for read-only users), 7 (UI), 8 (daily files, `coverageRetentionDays`), 9,
12 (decisions). ARCHITECTURE 2.5, 2.5a, 2.9, 2.11, 6 (security), 7 (files).

## Approach
- **Routes**, registered through the same `router.access('readonly')` getter
  as every other route (SPEC 6.1), cached like the data routes:
  - `GET /export/coverage.csv?window=24h|7d|all&all=false`
  - `GET /export/longrange.csv?window=24h|7d|all&anonymise=false`
  - `GET /export/longrange.geojson?window=24h|7d|all&anonymise=false`

  There is no coverage GeoJSON: cells go out as H3 ids only, with no polygons
  (decision 21). Errors stay JSON (400, 503) as in `handle()`.
- **Windows.** `24h` and `7d` mean what they mean on `/coverage` (UTC days,
  `24h` is today) and `/longrange` (rolling). `all` is every day the files
  still hold: `coverageRetentionDays` UTC days, today included. No archive
  (decision 22). `1h` is rejected.
- **Coverage CSV** columns: `h3_cell,resolution,reports,min_distance_m,capped`.
  Built from `Coverage.footprint(days)`, which already merges older files to
  the configured resolution, so one export has one resolution. `all=true`
  adds the cells beyond the distance cap with `capped=true`, as on
  `/coverage`; the cap is not applied to anything else (SPEC 2.4).
  Anonymise has no effect here: cells hold no MMSIs or own position.
- **Long-range CSV** columns: `time,mmsi,name,class,ship_type,distance_m,
  bearing_deg,lat,lon,own_lat,own_lon`, every entry in the window (not the
  25 of `/longrange`), sorted by time. **GeoJSON:** a FeatureCollection of
  Points at `[lon, lat]` with the same fields as properties (`distanceM`,
  `bearingDeg`, `ownLat`, `ownLon`, ...); no line features.
- **Anonymise** (decision 20, default off): drops the `mmsi` and `name`
  columns, the own position and the reported target position entirely
  (maintainer, after review: a target position with distance and bearing
  gives the own position back). Time, class, ship type, distance and
  bearing stay. With no positions left there is nothing to map, so
  `longrange.geojson?anonymise=true` answers 400 and the web app offers
  anonymised export as CSV only.
- **CSV format.** RFC 4180: comma separator, CRLF, header row, UTF-8. A field
  holding a comma, quote, CR or LF is quoted, quotes doubled. Vessel names are
  untrusted AIS input (ARCHITECTURE 6), so a text field starting with `=`,
  `+`, `-`, `@`, tab or CR gets a leading `'` against spreadsheet formula
  injection. Numbers in plain decimal with a dot, times ISO 8601 UTC, units
  in SI as in the column names. Empty field for an unknown name or type.
- **Headers.** `Content-Type: text/csv; charset=utf-8` or
  `application/geo+json`, `Cache-Control: no-store`, and
  `Content-Disposition: attachment; filename="ais-<set>-<window>-<YYYY-MM-DD>[-anon].<ext>"`,
  for example `ais-longrange-7d-2026-11-01-anon.csv` (UTC date of the export).
- **Plumbing.** `ApiDeps` gains `retentionDays: () => number`;
  `LongRangeLog.entries` is called with a limit of `MAX_PER_DAY` times the
  window's days. Serializers live in a pure `src/export.ts`; `api.ts` gains a
  `handleFile` beside `handle` that sends a string body with the headers.
- **Web app.** Plain `<a href download>` links (same origin, the session
  cookie goes along): on the map, "CSV" for the current window plus "All
  days", following the `All cells` toggle; under the long-range table, "CSV"
  and "GeoJSON" for the table's window plus "All days", and an "Anonymise"
  checkbox. Touch targets of 48 px (SPEC 7).

## Test Strategy
- `test/export.test.ts`: escaping (comma, quote, CRLF, leading `=`, `-` in a
  negative number left alone), column order, anonymise drops the identity and position columns,
  anonymised GeoJSON gives 400, GeoJSON coordinate order, empty sets give a header only.
- `test/api.test.ts` with `test/fixtures/router.ts`: headers and file names,
  `window=all` reads every retained file and nothing pruned, `1h` and bad
  `anonymise` values give 400, a stopped plugin gives 503, routes are
  registered through `access('readonly')`.
- Fixtures: synthetic day files in a temporary directory, MMSIs in the
  `999000001` style of `test/longrange.test.ts`, invented names and positions.
- Manual: download each file on a development server, open the CSV in a
  spreadsheet and the GeoJSON and CSV (H3 plugin) in QGIS; phone width.

## Implementation Steps
- [ ] Tests for `src/export.ts` and the routes (separate commit)
- [ ] `src/export.ts`: `csvField`, `csv(rows, columns)`, `coverageCsv`,
      `longRangeCsv`, `longRangeGeoJson`, `anonymise`
- [ ] `api.ts`: `handleFile`, the three routes, `retentionDays` in `ApiDeps`;
      wire it in `plugin.ts`
- [ ] Web app: download links on the map and under the long-range table
- [ ] Docs: SPEC 6.1 table and text, 7 (download links), 8 (exports reach
      back `coverageRetentionDays`), 9 note on `coverageRetentionDays`;
      ARCHITECTURE 2.9, 2.11, 6 (exports carry MMSIs by default, formula
      escaping), 7 (`src/export.ts`); README "What it does" bullet

## Files to Create/Modify
- `src/export.ts` (new), `src/api.ts`, `src/plugin.ts`
- `web/src/map.ts`, `web/src/main.ts`, `web/src/api.ts`, `web/static/style.css`
- `test/export.test.ts` (new), `test/api.test.ts`
- `SPEC.md`, `ARCHITECTURE.md`, `README.md`, the 1.0.0 roadmap

## Open Points
- **#17** stores cells per mode in the day file (decision 18). The export
  reads combined cells through `Coverage`; if #17 adds a mode parameter to
  `/coverage`, the coverage export takes the same parameter. Whichever lands
  second adapts.
- **#16** adds the fastest-vessels list to the long-range file (decision 16).
  The export reads entries only, so the loader must keep accepting older
  and newer file versions; exporting the fastest list is not part of #19.
- **#20** documents the export columns in `docs/paths.md` or the README
  without a stability promise (decision 24), and adds the first write route,
  which changes the SPEC 6.1 "no write routes" text; the exports stay GET
  and read-only either way.
- The filename pattern is this plan's choice; the decisions do not fix it.
- A coverage footprint centred on a harbour still hints at the berth, and
  anonymise does not change cell exports. Raise with the maintainer
  whether anonymised coverage should drop cells near the own positions.
- SPEC 2.4 still says the default H3 resolution is 5, while SPEC 9 and
  `src/config.ts` say 6; fix 2.4 in the same change.
