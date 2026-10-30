# Implementation Plan: roadmap item 7, web app

## Overview
The SignalK web app with overview, charts, radar and map views.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 7; ARCHITECTURE 2.11.

## Approach
- Framework-free TypeScript bundled by esbuild into `public/` (about 160 KB
  with Leaflet, no CDN). The package keyword `signalk-webapp` makes the
  server serve it at `/signalk-ais-statistics/`.
- Charts are small hand-written SVG charts (line and stacked bars) with a
  hover tooltip and legend, sized to the screen width; no chart library.
  Categorical colours follow a colour-blind checked palette (blue, orange,
  aqua, yellow), with dark-mode steps.
- Overview: message and position counts, unique vessels by type group (up
  to 24 hours), distance p99, p95, median, average and the untrusted maximum.
- Radar: one polar chart per class, radius the highest hourly p99 per
  sector.
- Map: Leaflet with the coverage GeoJSON, windows today, 7 and 30 days. The
  basemap switch offers OpenStreetMap with OpenSeaMap, or the tile charts
  from the server's resources API. Default from `network.internet.state`
  (`online` gives OSM, `offline` or `metered` gives server charts), falling
  back to `navigator.onLine`; a manual choice is stored in `localStorage`.

## Test Strategy
Manual: rendered with synthetic data from the real plugin modules in a
headless browser at desktop and phone width, with no internet access (OSM
tiles blocked). No browser errors. The logic that matters (queries,
coverage) is unit tested on the plugin side.

## Implementation Steps
- [x] Views, charts, map, basemap switch
- [ ] Screenshots with synthetic data for the registry (first release)

## Files to Create/Modify
`web/src/*`, `web/static/*`, `web/build.mjs`.

## Open Points
None.
