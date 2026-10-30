# Implementation Plan: roadmap item 1, plugin scaffold

## Overview
TypeScript project, plugin entry, configuration schema, published path
names, test and lint tooling, CI and the publish workflow, so that the
following items only add modules.

## Relevant SPEC/ARCHITECTURE Sections
SPEC 6.2 (paths), SPEC 9 (configuration), ARCHITECTURE 4 (stack) and 7
(file structure), [docs/release.md](../release.md).

## Approach
- CommonJS output from `tsc`, because the server loads plugins with
  `require()`. `src/index.ts` only re-exports the factory from `plugin.ts` so
  tests can import named exports.
- TypeScript 6.0, because `typescript-eslint` does not yet support 7.
- The web app is bundled with esbuild into `public/` (git-ignored, built by
  `prepare`), so `files` ships `dist` and `public`.
- Runtime dependencies: `ggencoder`, `h3-js` and `@js-temporal/polyfill`
  (the History API takes `Temporal.Instant` values). `express` stays out.

## Test Strategy
Unit tests for configuration defaults and clamping, and for the path
labels (two-digit bins, three-digit sector bearings, 48 sector paths).

## Implementation Steps
- [x] package.json, tsconfig, Vitest, ESLint, Prettier
- [x] `config.ts`, `paths.ts`, plugin entry
- [x] Test workflow and release-triggered publish workflow
- [ ] SignalK reusable plugin CI workflow pinned to a release SHA (needs the
      SHA looked up, done with the first release)

## Files to Create/Modify
`package.json`, `tsconfig*.json`, `vitest.config.ts`, `eslint.config.mjs`,
`.prettierrc.json`, `.github/workflows/*`, `src/index.ts`, `src/plugin.ts`,
`src/config.ts`, `src/paths.ts`, `web/build.mjs`, `test/*.test.ts`.

## Open Points
None.
