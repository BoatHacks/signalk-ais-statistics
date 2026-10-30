# Implementation Plan: roadmap item 9a, signalk-plugin and registry compliance

## Overview
Bring the package up to the conventions of Tobi's `signalk-plugin` skill
and to a full 100 in the SignalK plugin registry (`signalk-registry`
skill), ahead of the first release (roadmap item 9). Plan only; nothing
here is implemented yet.

## Relevant SPEC/ARCHITECTURE Sections
[docs/release.md](../release.md), ARCHITECTURE 4 and 8, SPEC 6.1 and 6.3.
External: the registry's `test-harness/score.ts`, `runner.ts` and
`app-shim.ts` (SignalK/signalk-plugin-registry), and SignalK's reusable
`plugin-ci.yml`.

## Where the project stands (checked 2026-10-30 on the PR branch)

Registry score, projected (the plugin is not on npm yet, so there is no
published score):

| Criterion | Points | Status |
|---|---|---|
| Installs | 20 | expected: `npm install <pkg>@<ver> --ignore-scripts`; `dist/` and `public/` ship in the tarball because `prepare` builds before publish |
| Loads | 15 | expected: the factory is the module export (smoke check in CI) |
| Activates | 15 | expected, see "Harness app shim" below |
| Schema | 5 | yes |
| Tests pass | 25 | expected, see "Tests in the harness" below |
| Security audit | 20 | `npm audit --omit=dev`: 0 vulnerabilities |
| Changelog | -5 | **missing**: no `CHANGELOG.md`, no GitHub Release |
| Screenshots | -5 | **missing**: no `signalk.screenshots` |
| Plugin-CI | -10 | **missing**: no `.github/workflows/plugin-ci.yml` |
| Core deps held back | -80 | not affected: `@signalk/server-api` is a devDependency only |
| Legacy deps | -15 each | not affected: no baconjs < 3 or React in dependencies |

Projected today: 80. After the three gaps: 100.

`signalk-plugin` skill conventions:

| Convention | Status |
|---|---|
| `signalk-node-server-plugin` and `signalk-category-*` keywords | yes |
| `files` lists what ships, `prepare` builds | yes (`dist`, `public`) |
| Few runtime dependencies, `express` only as `import type` | 3 deps (ggencoder, h3-js, Temporal polyfill), express types only |
| Config `schema` | yes |
| Periodic work wrapped in try/catch per step | yes (minute publish, hourly flush, sentence handler) |
| Publish with `app.handleMessage(plugin.id, ...)` | yes |
| Serve data through the resources API, not `/plugins/*` routes | **differs**: REST and the overlay GeoJSON use `/plugins/<id>/*` with `router.access('readonly')`; see open point 1 |
| `publish.yml` with npm OIDC trusted publishing | present; first publish still manual |
| `signalk.displayName` | "AIS Statistics" |
| `signalk.recommends` match the README | yes; all three resolve on npm (`signalk-questdb`, `@meri-imperiumi/signalk-internet`, `@signalk/freeboard-sk`) |
| Repo description, homepage (npm URL), topics | to check and set at release (needs GitHub admin access) |

## Approach

1. **Plugin CI (-10).** Add `.github/workflows/plugin-ci.yml` calling
   `SignalK/signalk-server/.github/workflows/plugin-ci.yml@1bf8c461ca47a735fc3e8d4a1c4e8f20614aa9fd # v2.35.1`
   (the commit of the latest server release tag; the workflow file is
   present at that commit). Pass `format-check-command: npm run
   format:check`. Keep `test.yml` for typecheck, lint and smoke, or fold
   them into the reusable workflow's inputs if it offers them.
2. **Changelog (-5).** Add `CHANGELOG.md` in Keep a Changelog format with
   an `Unreleased` section and `0.1.0` for the first release, and cut a
   GitHub Release `v<version>` on each publish (that also triggers
   `publish.yml`).
3. **Screenshots (-5).** Add `scripts/screenshots.cjs`, which runs the
   real plugin modules on a synthetic timeline (MID 999 MMSIs, positions
   near 0N 0E, as in the tests), serves the built web app and captures the
   overview, charts, radar and map at phone and desktop width with
   Playwright. Commit the images to `docs/screenshots/`, list them in
   `signalk.screenshots` and add `docs/screenshots` to `files`. No real
   vessel data: synthetic only, per CLAUDE.md. If the visual guideline work
   (item 7b) lands first, take the screenshots after it.
4. **Tests in the harness.** The harness clones the repository at the
   published `gitHead` or the tag `v<version>`, runs `npm ci
   --ignore-scripts`, then `npm test` under `firejail --net=none` with a 60
   second limit. Add a CI job that does the same (`npm ci --ignore-scripts
   && npm test` with networking off where the runner allows) to prove
   Vitest and esbuild work without install scripts and offline.
5. **Harness app shim.** The shim's `streambundle.getSelfStream().onValue()`
   returns the mock bus, not an unsubscribe function, and it has no
   `getHistoryApi`. `stop()` already catches the failed call, but guard it
   explicitly (`typeof unsubscribe === 'function'`). Add a plugin test that
   starts and stops the plugin against a shim-like app: no-op `on`, mock
   bus, no history API, no `registerWithRouter` call.
6. **Release metadata.** `signalk.appIcon` (an SVG icon, also the favicon,
   shared with item 7b), `author`, `engines.node >= 22` (present). Bump the
   version before each release and confirm it is not already on npm. The
   name `signalk-ais-statistics` is free on npm today.
7. **Repo presentation (not scored).** Description, homepage
   `https://www.npmjs.com/package/signalk-ais-statistics`, topics
   `signalk`, `signalk-plugin`, `marine`, `ais`. Set at the first release,
   when the repository is made public.
8. **Docs.** Update [docs/release.md](../release.md) with the pinned SHA
   and the harness details above, and tick the matching roadmap item 9
   boxes.

## Test Strategy
- The plugin CI workflow itself runs on Linux x64 and arm64, macOS and
  Windows with Node 22 and 24.
- The harness-like job (install without scripts, tests offline).
- A plugin test against a shim-like app.
- After the first publish, read the published score with the
  `signalk-registry` check 0 and confirm 100.

## Implementation Steps
- [ ] plugin-ci.yml pinned to v2.35.1
- [ ] CHANGELOG.md
- [ ] Synthetic screenshot script, images, `signalk.screenshots`, `files`
- [ ] Harness-like CI job and shim-like plugin test, unsubscribe guard
- [ ] `signalk.appIcon`, `author`
- [ ] release.md and roadmap updates
- [ ] At release: GitHub Release `v0.1.0`, repo metadata

## Files to Create/Modify
`.github/workflows/plugin-ci.yml`, `.github/workflows/test.yml`,
`CHANGELOG.md`, `scripts/screenshots.cjs`, `docs/screenshots/*`,
`package.json`, `src/plugin.ts`, `test/plugin.test.ts`, `docs/release.md`,
`docs/plans/mvp-roadmap.md`.

## Open Points
1. **REST and overlay data on `/plugins/*`.** The `signalk-plugin` skill
   says to serve data through the resources API because `/plugins/*` routes
   are admin-gated; Freeboard-SK's provider guide says the same. Server
   2.35.1 has `router.access('readonly')`, which this plugin uses, so the
   routes work for read-only users there. Whether that includes anonymous
   access under `allow_readonly` is being checked by the spike on the
   development server. If it does not, move the overlay GeoJSON (and
   possibly the statistics) to a read-only resource type.
2. **Screenshots before or after the restyle.** Taking them now and again
   after item 7b costs little; waiting avoids churn. Default: after item 7b.
3. **The plugin CI pin goes stale** with every server release. The
   `signalk-registry` skill's check 4 compares it; run it before each
   release.
