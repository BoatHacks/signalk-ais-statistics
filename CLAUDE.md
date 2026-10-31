# CLAUDE.md

Orientation for AI coding agents working in this repository. Humans should
start with [README.md](README.md).

## What this is

A SignalK server plugin (TypeScript) that computes AIS reception statistics
on the vessel: counts, distance percentiles, a bearing radar and coverage.
It publishes numeric paths under `sensors.ais.statistics.*`, reads history
back through the SignalK History API, serves a web app, and offers the
coverage footprint as a Freeboard-SK plotter overlay.

**Current state: 0.1.3, the MVP (roadmap items 1 to 8), released.**
The remaining open point is the Freeboard-SK visual check (SPEC section 13).
The roadmap is [docs/plans/mvp-roadmap.md](docs/plans/mvp-roadmap.md).

## Read in this order

1. [SPEC.md](SPEC.md) for what and why. Section 12 lists decisions that were
   chosen by the maintainer; do not reopen them without asking. Section 13
   lists what is still unverified.
2. [ARCHITECTURE.md](ARCHITECTURE.md) for how it is organized.
3. [docs/findings.md](docs/findings.md) for verified facts about the SignalK
   server, the History API and Freeboard-SK, with commands to re-check them.
4. [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) for the
   workflow to follow on every change.
5. [docs/plans/mvp-roadmap.md](docs/plans/mvp-roadmap.md) for the order of work,
   and [docs/plans/plan-template.md](docs/plans/plan-template.md) for the plan
   you write before implementing an item.
6. [docs/release.md](docs/release.md) when preparing a release.

## Working rules

- **Ask before starting an issue.** Raise open questions with the maintainer
  first, then decide what to delegate. Use the plan template for the plan.
- **This repository will be public.** Never commit real vessel data: no real
  MMSIs, vessel or station names, coordinates, hostnames, IP addresses,
  credentials, tokens, recordings or screenshots. Test fixtures are synthetic
  or from public sources. Do not copy values out of a running server into the
  repository, including its address and configuration.
- **Keep the docs current.** Update SPEC.md, ARCHITECTURE.md, the roadmap and
  the README status in the same change that alters what they describe.
  Resolved items leave SPEC section 13 and move into the relevant section.
- **Design constraints that are easy to break:**
  - Nothing is filtered or dropped in the aggregator; only coverage has a
    percentile cap (SPEC 2.3, 2.4).
  - Published values are numeric only. Counts are cumulative counters because
    the History API has no `sum` or `count` aggregate (SPEC 4.1, 8).
  - The plugin reads history only through the History API and uses only the
    aggregates every provider is expected to have (`last`, `max`).
  - Cell sets live in small daily files in the plugin data directory; they are
    the only state the plugin owns (SPEC 8).
  - Published path names are defined once, in `src/paths.ts`.
- **Do not trust unverified assumptions.** If code depends on something listed
  in SPEC section 13, run the spike in the roadmap first and record the result.
- **Testing against a SignalK server:** the spikes in the roadmap need a
  server with a History API provider. Ask the maintainer which server to
  use and do not assume one; unit tests should use an in-process fake of the
  History API instead. Use a development server. Do not
  bind-mount the plugin into the server's `node_modules`; link it with a
  `file:` dependency or install it normally. Plugin updates take effect only
  after the server restarts.
- **Commits.** Explain why, reference the issue, keep tests in a separate
  commit from the implementation. Commits are authored under the maintainer's
  own git identity; do not add co-author or generated-by trailers.
- **Prose.** No em dashes in documentation or comments. Comments must read
  correctly a year from now (no "new" or "recently added").

## Commands

- `npm test`: Vitest unit tests (`test/`, fakes in `test/fixtures/`)
- `npm run typecheck`: plugin and web app
- `npm run lint`, `npm run format:check` (Prettier; `npm run format` fixes)
- `npm run build`: `dist/` from `src/` and `public/` from `web/`
- `npm run smoke`: loads the built package with `require()`

CI runs all of them on Node 22 and 24.
