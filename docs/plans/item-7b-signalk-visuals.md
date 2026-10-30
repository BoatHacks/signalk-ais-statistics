# Implementation Plan: roadmap item 7b, SignalK visual guidelines

## Overview
Bring the web app in line with the SignalK plugin UI guidelines Tobi
adopted (the "signalk-visuals" context in bergie/dotfiles): dark tactical
look with day and night intensity from `environment.mode`, custom elements
with granular DOM updates, hash routing, a WebSocket with backoff, and
units from the server's display unit preferences instead of hard-coded nm.

## Decisions already made (2026-10-30, Tobi)
1. Dark-only tactical look, day and night driven by `environment.mode`.
   SPEC 7 changes from "follows the SignalK admin UI look".
2. Keep TypeScript and esbuild (the guideline asks for no build tools), but
   the views become custom elements that cache their nodes in
   `connectedCallback` and update `textContent` and attributes only.
3. Follow the server's unit preferences: the REST API returns SI (metres,
   square metres) and the app converts with the path's `meta.displayUnits`.
   SPEC 6.1 field names change from `...Nm` / `...Km2` to `...M` / `...M2`.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 6.1, 6.2, 7, 12; ARCHITECTURE 2.11 and 4.

## Approach
- **Theme.** CSS custom properties from the guideline (`--bg-base`
  `#080a0c`, panels, the five semantic colours in day and night steps).
  `data-mode` on `<html>` from `environment.mode` (`day` when the path is
  absent). Flat geometry, no radius or shadow, 2px corner brackets with
  pseudo-elements on `.sk-card`, `.theme-*` classes, uppercase tracked
  labels, monospace tabular values. `<meta name="theme-color"
  content="#080a0c">`.
- **Chart colours.** Class A teal, class B orange, other green; distance
  series p99 teal, p95 orange, median green, average grey. Radar wedges use
  the class colours. All from the semantic variables, so night mode dims
  them.
- **Structure.** One custom element per view (`ais-overview`,
  `ais-charts`, `ais-radar`, `ais-map`) plus small ones (`ais-stat` tile,
  `ais-status`). Each builds its DOM once and exposes `update(data)`.
  Charts redraw their SVG paths by setting `d` and `points` attributes on
  cached elements rather than rebuilding the SVG.
- **Routing.** `hashchange` with `#/overview`, `#/charts`, `#/radar`,
  `#/map`, window as a query part (`#/charts?window=7d`).
- **Live data.** One WebSocket to `/signalk/v1/stream?subscribe=none`,
  subscribing with `minRate: 5000` to `environment.mode`,
  `environment.time.timezoneOffset` and `network.internet.state`.
  Reconnect with exponential backoff (1 s doubling to 60 s, with jitter);
  an offline banner (`.theme-offline`) while disconnected. Statistics stay
  on REST, polled every 60 s while the tab is visible.
- **Units.** The plugin publishes SI values and sets default metadata with
  `app.setDefaultMetadata` (`units: 'm'`, `displayUnits.category:
  'distance'`; area in `m2`). The app reads `meta.displayUnits` for one
  distance path and one area path from the full tree and converts with its
  `formula`, evaluated by a small arithmetic parser (no `eval`). Without
  display units it shows SI with ISO prefixes (`12.3 km`, `4.1 km²`).
- **Time.** Ship-local times without a zone suffix when
  `environment.time.timezoneOffset` is present, otherwise UTC with `Z`.
  Dates as `YYYY-MM-DD`.
- **Touch and layout.** 48 px minimum targets, single column on phones,
  grids with `auto-fit` and `clamp()`; map at `calc(100vh - 140px)` on
  desktop and `min-height: 50vh` on phones, Leaflet controls restyled as
  floating dark panels.
- **Icon.** Tobi's graphic as a 512 px PNG at `public/icon.png` (built
  from `web/static/icon.png`), referenced by `signalk.appIcon` and used as
  the favicon from the same file, plus `favicon.ico` and a touch icon.
- **Licensing.** No change; all runtime and bundled dependencies are
  permissive and EUPL-1.2 compatible (ggencoder and h3-js Apache-2.0,
  Leaflet BSD-2, Temporal polyfill ISC).

## Test Strategy
- Unit tests (Vitest, node environment) for the pure web helpers: the
  formula parser and unit conversion, ISO prefix formatting, ship-time and
  date formatting, hash route parsing, the backoff schedule.
- Plugin tests updated for SI paths and SI REST fields, and for the default
  metadata being set.
- Manual: headless browser screenshots in day and night mode, desktop and
  phone width, offline (WebSocket refused) to see the offline state.

## Implementation Steps
- [x] Settle the open point below (SI paths, chosen by Tobi)
- [x] Plugin: SI paths and REST fields, default metadata
- [x] Web: theme, icon, custom elements, routing, WebSocket, units, time
- [x] Tests, screenshots, SPEC 6.1, 6.2, 7, 12 and ARCHITECTURE 2.11

## Files to Create/Modify
`src/paths.ts`, `src/publish.ts`, `src/query.ts`, `src/api.ts`,
`src/plugin.ts`, `src/overlay.ts`, `web/src/*`, `web/static/*`,
`package.json`, tests, SPEC.md, ARCHITECTURE.md.

## Open Points
- **Published path names (resolved: SI paths).** SignalK expects SI values, and display units
  come from path metadata, so the published distance and area paths would
  move to SI too: `distance.p99` in metres instead of `distance.p99Nm`,
  `coverage.area.today` in m² instead of `coverage.areaKm2.today`. Nothing
  is released, so no history needs migrating. This changes the persistence
  schema in SPEC 6.2, so it needs Tobi's yes.
- The display unit conversion depends on the server's `meta.displayUnits`
  (server 2.35 has `getDisplayUnits` and `setDefaultMetadata`); check on the
  development server that the REST meta carries it for plugin paths.
