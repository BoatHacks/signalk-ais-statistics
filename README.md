# signalk-ais-statistics

A SignalK server plugin that turns the AIS traffic your server already
receives into reception statistics for your own AIS station.

**Status: design phase.** The design documents are written and there is no
code yet. Nothing is published to npm.

## What it will do

- Count vessels (by type group and class A/B), positions and messages per
  minute and hour.
- Report how far your receiver reaches: average, median, p95, p99 and max
  distance, plus a 24-sector bearing radar per class. Percentiles keep the
  numbers meaningful when a bad position arrives.
- Track coverage: which areas you have actually received traffic from, per
  day, for a moving boat.
- Publish all of it as numeric SignalK paths under `sensors.ais.statistics.*`,
  so any history provider (QuestDB, InfluxDB, ...) records it.
- Show graphs, a radar and a coverage map in a SignalK web app that works on
  a phone and offline.
- Offer the coverage footprint as an overlay layer for chart plotters that
  support Plotter Extensions, such as Freeboard-SK.

## Documents

| Document | Purpose |
|---|---|
| [SPEC.md](SPEC.md) | what the plugin does and why: rules, data model, published paths, API, MVP scope, decisions, open questions |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how it is built: components, stack, integration points, file layout |
| [docs/findings.md](docs/findings.md) | verified facts about the SignalK server and plotters, with commands to re-check them |
| [docs/plans/mvp-roadmap.md](docs/plans/mvp-roadmap.md) | ordered work items for the MVP |
| [docs/plans/plan-template.md](docs/plans/plan-template.md) | template for a per-issue plan |
| [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) | workflow to follow for every change |
| [docs/release.md](docs/release.md) | first release and plugin registry checklist |
| [CLAUDE.md](CLAUDE.md) | orientation for AI coding agents working in this repository |

## Requirements (planned)

- A SignalK server with raw AIS sentences arriving (any AIS receiver input).
- Optional but recommended: a History API provider such as `signalk-questdb`
  for history beyond the running process.

## License

MIT, see [LICENSE](LICENSE).
