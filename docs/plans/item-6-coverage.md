# Implementation Plan: roadmap item 6, coverage

## Overview
Collect the H3 cells that received traffic per UTC day, keep them in small
daily files, and serve a capped footprint for a window.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 2.4 and 8; ARCHITECTURE 2.5.

## Approach
- One JSON file per UTC day, `coverage-YYYY-MM-DD.json` in the plugin data
  directory: per cell the shortest distance and the report count, and the
  day's distance histogram. Written atomically (temporary file and
  rename) hourly, at the day change and on stop; today's file is loaded on
  start.
- The window's percentile cap comes from the merged histograms of the day
  files, so the footprint needs no history provider. Cells whose shortest
  distance is beyond the cap are left out and counted as `cappedCells`.
- Area is cell count times the mean cell area at the resolution.
- Cells from files written at another resolution are converted (parent or
  centre child), so changing `h3Resolution` keeps old days usable.
- Memory and file size are bounded at 20000 cells per day.
- GeoJSON: one polygon per cell with `id`, `intensity` (log of reports
  relative to the busiest cell), `reports` and `minDistanceNm`, coordinates
  rounded to 1e-5 degrees to keep payloads small.

## Test Strategy
Unit tests in temporary directories: cells and area, the cap dropping a
2500 nm bogus cell, restart reload, day change, window union, retention,
corrupt files, resolution conversion, closed polygons.

## Implementation Steps
- [x] `coverage.ts`, `/coverage` route
- [x] Tests

## Files to Create/Modify
`src/coverage.ts`, `src/api.ts`, `test/coverage.test.ts`.

## Open Points
SPEC 13.2 (how many cells the plotter overlay handles smoothly).
