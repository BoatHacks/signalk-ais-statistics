# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-11-01

### Added

- A tab, window or map button whose click starts a load fades out and in
  (0.5 s per cycle) until the data or basemap tiles have loaded.
- Message health (#16): seven counters under
  `sensors.ais.statistics.health.*` for decode errors, incomplete
  multipart messages, duplicates on the same event and across events
  (same MMSI, type and position within 2 s, matched across the NMEA 0183
  and NMEA 2000 inputs), invalid positions, implausible position jumps and
  position reports received without an own position. They only count;
  every message still counts everywhere else.
- Jump limits as settings: 60 kn, 120 kn for high-speed and WIG craft
  (ship types 40 to 49 and 20 to 29) and 600 kn for SAR aircraft.
- The overview shows the share of good messages and each health counter,
  and a hint when more than 20 percent of the messages are duplicates,
  which usually means one receiver reaches two configured events.
- Charts of the class A/B mix and of the health shares over time.
- Fastest vessels and implausible jumps on the sectors page: per day the
  10 highest plausible implied speeds and the 10 fastest jumps above the
  limit, each with the reported speed over ground beside it. `GET
  /longrange` returns them as `fastest` and `implausibleJumps`,
  `GET /summary` gains `health`, and `GET /series` takes `metric=health`.
- Downloads (#19): the coverage cells as CSV of H3 ids (under the map)
  and the farthest receptions as CSV or GeoJSON points (on the sectors
  page), for today, 7 days or every retained day, through `GET
  /export/coverage.csv`, `/export/longrange.csv` and
  `/export/longrange.geojson`. Anonymise drops MMSIs, names and all
  positions from the receptions, so an anonymised download is CSV only.
- Range vs weather (#15): on the 24h and 7d charts, hourly p99 range next
  to air pressure, air or water temperature, humidity or air minus water
  temperature, and a scatter of the two with Pearson's r. Hours with fewer
  than 20 reports stay out of the scatter. The weather comes from the
  history provider as hourly averages, so the provider must record those
  paths; the plugin stores nothing new. The paths are a setting,
  `weatherPaths` (at most 8), served by `GET /weather`.

### Changed

- Every sector with a reception shows its farthest-reception tick, drawn
  from the centre to a dot at that distance, also when the farthest
  reception is at the wedge's edge. The tick of the chart's farthest
  reception is broader.
- The daily long-range files are version 2, with the fastest list beside
  the farthest receptions. Version 1 files still load.

### Fixed

- A sector's p99 no longer exceeds the farthest reception in that sector.
  The per-sector histogram bins are about 60 percent wide, and the p99 was
  interpolated within its bin without a cap, so a sector with all its
  reports low in a bin got a radius beyond any of them and its
  farthest-reception tick vanished inside the wedge. Each hour's p99 is now
  capped at that hour's farthest reception, and a window's p99 at the
  window's farthest reception, which also corrects hourly values already
  in history.

## [0.4.0] - 2026-11-01

### Added

- Each sector draws a thin tick out to its farthest reception, with
  the distance and time on hover. A tick beyond the scale stops at the rim
  and is dashed. Rare far receptions, such as sporadic E or tropospheric
  ducting, stay visible without changing the radius.
- Farthest receptions: per UTC day the plugin logs the farthest position
  of each vessel (up to 50 a day) with time, MMSI, vessel name when known,
  class, distance, bearing, the vessel's position and the own position.
  The sectors page lists the 25 farthest of the window, and `GET /longrange`
  serves them. The log is kept in daily files and pruned with
  `coverageRetentionDays`.
- `sensors.ais.statistics.sectors.<deg>.<class>.max`, the farthest
  reception per sector in the last hour, published hourly with the other
  sector paths.
- Map toggle "All cells" shows the cells beyond the distance cap, dashed.
  `GET /coverage?all=true` includes them, marked `capped`.
- The plotter overlay draws the sector maxima as thin lines.
- A distance cap slider under the map. Moving it redraws the coverage at
  once; Save stores it in the plugin config, and Reset goes back to the
  saved value. Save is offered only to readwrite and admin users, or to
  everyone while the server's security is off. This is the plugin's first
  write route, `POST /settings`, which accepts only these live settings.
- A Settings panel at the foot of every page lists the settings in effect.
- `docs/paths.md` lists every published path with its unit, kind and
  cadence. There is no stability promise for the paths yet.
- `GET /coverage` takes `cap` to try another percentile and reports
  `capPercentile`.

### Changed

- The coverage distance cap hides only cells with fewer than 3 reports.
  Far cells with repeated reports are real reception and now stay on the
  map, in the covered area and in the plotter overlay; single bogus
  positions are still left out.
- The bearing view is called "Sectors" instead of "Radar", so it is not
  mistaken for a radar overlay. The page is `#/sectors` and the REST route
  `GET /sectors`. The old `#/radar` and `GET /radar` are removed, so
  bookmarks and scripts that use them need updating.
- The map and the plotter overlay draw the 24 hour sectors per class,
  teal for class A and orange for class B as on the sectors page. The map
  has a toggle for each class ("Sectors A", "Sectors B"), both shown by
  default; a saved choice for the old "Radar 24h" toggle is not carried
  over. The overlay's
  sector features are now `kind: "sector"` and `"sector-max"` with the
  class in `cls`.

### Fixed

- A distance exactly on a distance bin edge is counted in the bin above
  it, as documented; one edge (about 0.79 nm) landed in the bin below.

## [0.3.2] - 2026-11-01

### Changed

- The radar distance of a sector counts only hours with at least 20
  reports in that sector. Sparse hours put the p99 at the top of its
  distance bin, so the radius was set by chance and the 24 hour and 7 day
  radars looked alike. Sectors without such an hour show their count but
  no radius.

### Fixed

- The app icon shows in the App Store and the Webapps list without a
  connection to unpkg. The server resolves `signalk.appIcon` against the
  served `public/` folder, so the path is now `./icon.png`.

## [0.3.1] - 2026-11-01

### Fixed

- Chart bars for the 24 hour and 7 day windows start on the full hour.
  They followed the minute the page was loaded, so hourly bars were
  labelled like 08:50 and looked like minutes.
- The radar for the 24 hour and 7 day windows includes the current hour.
  Since 0.3.0 the sector paths go out once an hour, and up to 59 minutes
  of sector counts were missing.
- Counts across a plugin restart are no longer lost when the counter
  restarted inside a bucket and climbed back to its previous value or
  higher before the bucket ended.

## [0.3.0] - 2026-11-01

### Added

- `publishIntervalMinutes` option, default 5.

### Changed

- The statistics paths are published every 5 minutes instead of every
  minute, and the per-sector radar paths once an hour, which more than
  halves what the history provider stores. Counters stay exact; history
  charts are no finer than the interval.
- Windows go up to 7 days; the 30 day window is gone.
- Coverage files are kept for 14 days by default instead of 90. Saved
  settings keep their value.
- History requests run one at a time and REST answers are cached for a
  minute. Parallel requests could make the history database exceed its
  memory limit on a busy server.
- When a history read fails, the web app shows live figures with a short
  note instead of the provider's error.

## [0.2.0] - 2026-10-31

### Added

- AIS from NMEA 2000 is read directly from the server's `N2KAnalyzerOut`
  event, so NMEA 2000 receivers no longer need a converter plugin such as
  `signalk-n2kais-to-nmea0183`. The default events are now `nmea0183` and
  `N2KAnalyzerOut`; saved settings keep their events. Contributed by
  dirkwa.

### Changed

- Installs that never saved their events switch from the converter's
  `nmea0183AISout` to `N2KAnalyzerOut` and count more messages after the
  update: the direct path also sees AIS types the converter does not
  re-encode, such as aid to navigation reports, binary broadcasts and data
  link management messages (about 28% more on one test receiver).
- The canboat lookup tables are a local copy, checked against
  `@canboat/ts-pgns` in the tests, so the 6.5 MB package is no longer
  installed with the plugin.
- MMSIs from NMEA 2000 are padded to nine digits like those from sentences,
  so a coast station counts as one vessel whichever input reports it.
- The map's first view frames the radar wedges as well as the coverage
  cells, so long wedges no longer run off the edge.
- When the server has no charts, the map's server charts button is greyed
  out with a note, and the map uses OpenStreetMap instead of a blank
  basemap.

## [0.1.2] - 2026-10-30

### Added

- Map view toggles to show or hide the coverage cells and the 24 hour radar
  wedges, remembered per browser.

### Changed

- The web app map draws cells and radar in the plotter overlay's colours,
  defined once and shared by both.

## [0.1.1] - 2026-10-30

### Changed

- The plotter overlay draws coverage cells on a magenta to purple ramp with
  outlines. The blue ramp was almost invisible over chart water.
- The npm package includes this changelog.

## [0.1.0] - 2026-10-30

First release.

### Added

- AIS reception statistics from raw sentences: message and position counts
  by class, unique vessels, distance percentiles, a 12 sector bearing radar
  and H3 coverage cells, published under `sensors.ais.statistics.*`.
- Configurable sentence events, by default `nmea0183` and `nmea0183AISout`
  (AIS from NMEA 2000 through a converter plugin).
- Windowed queries over the SignalK History API, with counter reset
  detection across plugin restarts.
- A web app with overview, charts, radar and coverage map.
- A Freeboard-SK plotter extension data overlay of the coverage and radar
  (Freeboard-SK 3.4.0 or later).
- A dark tactical web app theme following day and night mode, with
  distances in the server's display units and the plugin's app icon.

[Unreleased]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BoatHacks/signalk-ais-statistics/releases/tag/v0.1.0
