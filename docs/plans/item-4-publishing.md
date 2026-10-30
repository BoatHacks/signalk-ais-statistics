# Implementation Plan: roadmap item 4, publishing

## Overview
Publish the counters and gauges of SPEC 6.2 every minute with the plugin
as source.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 4.1, 6.2 and 8; ARCHITECTURE 2.6.

## Approach
`buildValues` is a pure function of the aggregator and the time, so the
whole delta is testable without a server. `publish` sends it through
`app.handleMessage(pluginId, ...)`, which sets the source label to the
plugin id. Counters are always published. A gauge without data is left
out instead of being published as zero (which would be a false figure) or
null (not numeric). Readers already treat a missing sample as unchanged
(SPEC 8), and the web app's distance series come from the bin counters,
not from these gauges, so a stale gauge cannot mislead the charts.

## Test Strategy
Unit tests: every counter present before any data, no empty gauges, all
values finite numbers under the prefix, no duplicate paths, one delta per
call with a timestamp.

## Implementation Steps
- [x] `publish.ts` and tests
- [x] Wiring into the minute timer (done with the plugin entry)

## Files to Create/Modify
`src/publish.ts`, `test/publish.test.ts`.

## Open Points
SPEC 13.1 (counter reset across a restart) is checked by the spike on the
development server.
