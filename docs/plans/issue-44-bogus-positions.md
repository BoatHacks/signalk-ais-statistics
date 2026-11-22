# Implementation Plan: #44 bogus positions in distance

## Overview
On one NMEA 2000 install, about 17 ordinary local vessels each sent a
single position with latitude exactly 0, which put the hourly distance
maximum off the scale in about 40 of 336 hours and crowded the long-range
log. A second install had no latitude 0 positions but one other mangled
position. The maintainer chose options 2 and 3 of the issue: latitude 0
far from the equator is an invalid position, and implausible jumps are
left out of distance and the long-range log, behind a setting.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 2.3 (bogus positions), 2.8 (message health), 9 (configuration), 10.2
(deferred speed filter) and 12 (keep everything, message health only
counts). ARCHITECTURE 2.4 (aggregator) and 2.4a (health).

## Approach
- **Latitude 0 (option 2).** A position report with latitude exactly 0,
  received while the own position is at least 5 degrees (about 300 nm)
  from the equator, is treated like an out-of-range position: the plugin
  takes its position away before the health check, so it counts in
  `health.positionInvalid`, is skipped for distance, coverage and the
  long-range log, and is not an anchor or a jump for the jump tracker.
  Counts and vessel counts keep it. The guard keeps real positions on the
  equator for receivers near it; 300 nm is far beyond VHF range, and the
  rule then also catches a vessel's first position, which option 3 cannot.
  Without a known own position the report is not judged; it is not used
  for distance anyway. A longitude of exactly 0 alone is a real place
  (the Greenwich meridian runs through busy waters) and is not judged.
- **Implausible jumps (option 3).** A setting, `skipImplausibleJumps`
  (default on), in the message health group of the config form. When on,
  a position report whose health verdict is an implausible jump still
  counts as a message and a position, but the aggregator does not use it
  for distance, so it reaches neither the histogram, the sectors, the
  coverage, the long-range log nor the propagation detector. The health
  counter and the implausible jump list are unchanged. Because one bogus
  position counts as two jumps, out and back, the real report after a
  glitch is also left out; that is one good sample per glitch, and keeping
  it would change how jumps are counted. The first position of a sender
  has no anchor and is never a jump.
- Rejected: dropping latitude 0 everywhere (loses real positions near the
  equator), and holding a far position back until a second one confirms it
  (more state for the rare first-position case).

## Test Strategy
Unit tests with synthetic MMSIs and positions computed with `destination`
from an own position away from the equator:
- `zeroLatitudeGlitch`: true for latitude 0 and -0 with own at 40 degrees
  north or south, false near the equator, for other latitudes and without
  an own position.
- Aggregator: a report added with `forDistance` false counts as a message
  and a position but not in the distance bins, sectors, or as located.
- Plugin: latitude 0 counts as an invalid position and no jump; an
  implausible jump is left out of distance and the long-range log with the
  setting on and kept with it off; config schema and order include the
  setting.

## Implementation Steps
- [ ] `zeroLatitudeGlitch` in `geo.ts`
- [ ] `forDistance` argument of `Aggregator.add`
- [ ] `skipImplausibleJumps` in `config.ts`, schema and order
- [ ] Plugin input handler: own position before the health check, the
      latitude 0 rule, and the jump verdict to the aggregators
- [ ] SPEC 2.3, 2.8, 9, 10.2, 12; README; CLAUDE.md; docs/paths.md;
      changelog

## Files to Create/Modify
`src/geo.ts`, `src/aggregate.ts`, `src/config.ts`, `src/plugin.ts`,
tests for each, `SPEC.md`, `ARCHITECTURE.md`, `README.md`, `CLAUDE.md`,
`docs/paths.md`, `CHANGELOG.md`.

## Open Points
None verified on a server yet: the effect on the install from the issue
shows only after a few days of history with the setting on.
