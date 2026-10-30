# Implementation Plan: roadmap item 2, ingest, decode, classify

## Overview
Turn raw `!AIVDM` sentences into typed messages, derive class and type
group, and track the own position with staleness.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 1.3, 2.1, 2.2, 2.3 and 5; ARCHITECTURE 2.1 to 2.3 and 5.

## Approach
- `Ingest` strips any prefix before `!` (NMEA 4.10 tag blocks), accepts any
  talker id with `VDM`, counts and drops `VDO`.
- ggencoder keeps one session for multipart messages, which breaks when two
  multipart messages interleave. `Ingest` therefore keeps one session per
  talker, part count, sequence id and channel, expires partial messages
  after 10 seconds and caps them at 256.
- ggencoder only rejects latitudes above 90 and longitudes above 180, so
  `Ingest` also rejects values below -90 and -180. A report without a usable
  position is still returned and still counts toward rates (SPEC 2.3).
- Vessels for unique counts are messages of class A or B; base stations,
  aids to navigation and SAR aircraft are not vessels. Type 9 counts as an
  `other` position report.

## Test Strategy
Unit tests with sentences built at test time by ggencoder's encoder in
`test/fixtures/ais.ts`: MMSIs with the unallocated MID 999 and positions
near 0N 0E, so all fixtures are synthetic. Cases: class A and B, message 5
in two parts, interleaved multipart, missing first part, expiry, message
24 part B, bad checksum, garbage, position not available, out-of-range
latitude, own transponder sentences, tag blocks.

## Implementation Steps
- [x] `classify.ts`, `ingest.ts`, `ownposition.ts`, `geo.ts`
- [x] Fixtures and tests

## Files to Create/Modify
`src/classify.ts`, `src/ingest.ts`, `src/ownposition.ts`, `src/geo.ts`,
`src/types/ggencoder.d.ts`, `test/fixtures/ais.ts`, tests.

## Open Points
None.
