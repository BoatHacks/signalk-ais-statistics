# Implementation Plan: roadmap item 8, chart plotter overlay

## Overview
Offer the coverage footprint and the bearing radar to chart plotters that
implement the Plotter Extensions API, such as Freeboard-SK.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 6.3; ARCHITECTURE 2.10; docs/findings.md (chart plotter overlay);
the Freeboard-SK documents `plotter-extensions-api.md` and
`plotter_extension_provider_plugins.md`.

## Approach
- A read-only `plotterExtensions` resource provider, registered once (the
  server cannot unregister providers) and answering only while the plugin
  runs with `publishOverlay` on.
- The MapLibre version 8 style is inline in the manifest (the API allows a
  style object), so no static style file is needed. Its one `geojson` source
  points at the read-only route `/plugins/<id>/overlay/coverage.geojson`,
  which the host fetches with the user's credentials. The route returns the
  7 day footprint (`kind: cell`, fill coloured by `intensity`) and the 24 hour
  radar as wedges from the last known own position to each sector's p99
  (`kind: radar`, outlined).
- The background runtime `plotterext/refresh.html` is a static page shipped
  in the web app bundle (served at `/<id>/plotterext/`). It completes the bus
  handshake and calls `overlay.refresh` hourly.
- Keyword `signalk-category-plotter-extensions` added.

## Test Strategy
Unit tests for the manifest shape (API version, `requires`, inline style,
source URL, background URL) and the radar wedges; plugin test for serving
the manifest only while running, no second registration on restart, and
the GeoJSON route returning cells and radar features.

## Implementation Steps
- [x] `overlay.ts`, route, background page
- [x] Tests
- [ ] Checked in Freeboard-SK on the development server (SPEC 13.1)

## Files to Create/Modify
`src/overlay.ts`, `src/api.ts`, `src/plugin.ts`,
`web/static/plotterext/refresh.html`, `package.json`, tests.

## Open Points
SPEC 13.1: how many cells the plotter draws smoothly. The Freeboard-SK
provider guide warns that `/plugins/*` routes are admin-only; this plugin
relies on `router.access('readonly')` (verified on server 2.35.1) for the
GeoJSON route. Older servers would need an admin login for the overlay
data.
