# Release and Registry Checklist

Everything needed to ship the plugin to npm and to score well in the SignalK
plugin registry. Work through it for the first release (roadmap item 9) and
reuse it afterwards.

## Package

- [ ] `package.json` has the keywords `signalk-node-server-plugin` and a
      `signalk-category-*` keyword; the first one is what lists the package in
      the SignalK app store
- [ ] `files` lists what must ship (`dist`, the built web app, the plotter
      extension files, screenshots); a missing `files` entry ships nothing
      because `.gitignore` excludes the build
- [ ] `"prepare": "npm run build"` so `npm publish` builds first
- [ ] `signalk.displayName` set to a human name, for the app store listing
- [ ] `signalk.recommends` names useful companions (a History API provider
      such as `signalk-questdb`, `@meri-imperiumi/signalk-internet`,
      Freeboard-SK); these are app store hints, not npm dependencies
- [ ] Few runtime dependencies; keep `express` out of them and use
      `import type` for its types
- [ ] MIT license, `package-lock.json` committed (CI uses `npm ci`)

## Registry score

The registry re-tests nightly on a 100 point scale. Items that can be fixed
in the repository:

- [ ] **Screenshots (5):** `signalk.screenshots` lists real image files that
      are also covered by `files`. Screenshots must not show real vessels,
      positions, MMSIs or station names; use synthetic data
- [ ] **Changelog (5):** a `CHANGELOG.md` in Keep a Changelog format, or a
      GitHub release for each version
- [ ] **Security audit (20):** `npm audit --omit=dev` is clean; fix by bumping
      the direct dependency that pulls in a vulnerable one
- [ ] **Plugin CI (10):** `.github/workflows/plugin-ci.yml` calls SignalK's
      reusable plugin CI workflow pinned to a release commit SHA with the
      version in a trailing comment, never to a branch. Bump the pin to the
      latest server release before each release; it also runs the format
      check on Windows, which is why `.gitattributes` forces LF
- [ ] **Install, load, activate, schema, tests (80):** run in the registry's
      own harness; the plugin must install cleanly, load, activate with the
      default configuration, expose a valid config schema, and pass `npm test`.
      The harness runs the tests from a clone at the `v<version>` tag after
      `npm ci --ignore-scripts`, without network and within 60 s; the
      `registry-harness` job in `test.yml` does the same
- [ ] Screenshots regenerated with `npm run build && node
      scripts/screenshots.cjs` after visible changes

## GitHub repository

- [ ] One-line description, topics `signalk`, `signalk-plugin`, `marine`,
      `ais`, and the npm package URL as homepage
- [ ] Branch protection decided before the repository is made public

## Publishing to npm

Use OIDC trusted publishing from a release-triggered GitHub Actions workflow,
so no token or one-time password is stored in CI.

1. `publish.yml` runs on `release: published`, with `id-token: write`
   permission, Node 24 (npm 11.5 or newer supports OIDC), `npm ci`,
   `npm test`, `npm publish`.
2. A new package cannot have a trusted publisher configured before it exists
   on npm. Publish the first version manually with `npm publish` and a
   one-time password, then configure the trusted publisher on npmjs.com for
   this repository and the workflow file name `publish.yml`.
3. After that, creating a GitHub release publishes automatically.
4. The npm website shows a new package at once, but the public registry
   can return 404 for a few minutes. That is propagation, not a failure.
5. A failing `npm publish` with `ENEEDAUTH` after passing tests means the
   trusted publisher is not configured or the repository or workflow name
   does not match.

## Before the repository is made public

- [ ] Privacy pass over the files and the full git history: no real MMSIs,
      vessel or station names, coordinates, hostnames, IP addresses, tokens,
      screenshots or recordings
- [ ] README describes real, working behavior and no longer says "design
      phase"
- [ ] SPEC section 13 resolved or removed
- [ ] Remove or archive `docs/plans` files that only describe work done
