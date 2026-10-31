# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BoatHacks/signalk-ais-statistics/releases/tag/v0.1.0
