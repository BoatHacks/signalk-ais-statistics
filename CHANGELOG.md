# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-11-01

### Added

- Each radar sector draws a thin tick out to its farthest reception, with
  the distance and time on hover. A tick beyond the scale stops at the rim
  and is dashed. Rare far receptions, such as sporadic E or tropospheric
  ducting, stay visible without changing the radius.
- Farthest receptions: per UTC day the plugin logs the farthest position
  of each vessel (up to 50 a day) with time, MMSI, vessel name when known,
  class, distance, bearing, the vessel's position and the own position.
  The radar page lists the 25 farthest of the window, and `GET /longrange`
  serves them. The log is kept in daily files and pruned with
  `coverageRetentionDays`.
- `sensors.ais.statistics.sectors.<deg>.<class>.max`, the farthest
  reception per sector in the last hour, published hourly with the other
  sector paths.
- Map toggle "All cells" shows the cells beyond the distance cap, dashed.
  `GET /coverage?all=true` includes them, marked `capped`.
- The plotter overlay draws the sector maxima as thin lines.

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

[Unreleased]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BoatHacks/signalk-ais-statistics/releases/tag/v0.1.0
