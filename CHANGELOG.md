# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/BoatHacks/signalk-ais-statistics/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BoatHacks/signalk-ais-statistics/releases/tag/v0.1.0
