# Implementation Plan: roadmap item 3, aggregation

## Overview
Reduce decoded messages to counters, minute and hour buckets, the distance
histogram, per-sector histograms and unique vessel counts.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 2.2, 2.3, 2.5, 2.6, 4.1, 4.2; ARCHITECTURE 2.4.

## Approach
- Distance histogram (`histogram.ts`): bin 0 is [0, 0.5) nm, bins 1 to 30
  step by 2^(1/3) up to 512 nm, bin 31 is the overflow bin. Percentiles are
  interpolated geometrically within the bin; the average uses bin centres
  (the overflow bin counts as 512 nm), so it can be computed the same way
  from published bin counters. The layout is part of the persistence schema.
- Sector histograms pair the distance bins (16 bins), enough for p99 per
  sector.
- The aggregator keeps cumulative totals for the counters, minute buckets
  for the last hour (rolling gauges) and hour buckets for the last 24 hours
  (live-only windows and the radar).
- Unique vessels: a registry of MMSI to last seen and ship type, ordered by
  last seen, pruned after 24 hours and capped at 50000. Unique counts for
  any window up to 24 hours come from it; the type group is the one known
  at counting time. Tracked targets for `/status` are the registry entries
  seen within `targetExpirySeconds`.

## Test Strategy
Unit tests with synthetic positions placed with `destination()` around
0N 0E: bin edges, percentile accuracy against exact values, robustness of
p99 to bogus 3000 nm positions, roll-over and expiry of minute and hour
buckets, missing own position, missing target position, vessel counts per
group and window, per-sector p99.

## Implementation Steps
- [x] `histogram.ts`, `aggregate.ts`
- [x] Tests

## Files to Create/Modify
`src/histogram.ts`, `src/aggregate.ts`, `test/histogram.test.ts`,
`test/aggregate.test.ts`.

## Open Points
None.
