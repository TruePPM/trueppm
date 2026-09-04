# `@trueppm/mobile` — scaffold only

**This package is a navigation shell and a set of typed module boundaries. It is
not an app you can install, and it is not a build you can run.** It exists so
that #41 (offline store + sync adapter) and the 0.6 native Android app have a
compiling place to land, and so the CI lint/type-check gates cover mobile code
from the first line.

Read this before quoting the package's state anywhere. Ten artifacts described
this scaffold as a working app; correcting them was #3367.

## Version

`0.0.0`, deliberately. The package is unpublished and unreleasable, so a version
number here can only mislead — it read `0.4.0-beta.1` from 2026-07-18 to
2026-09-04 because a hand-run manifest bump (`913ec927d`) swept it in alongside
`api` and `web`.

`scripts/release.sh` does **not** bump this manifest and must not start: mobile
does not ship on the OSS release train until the native Android app does.

`scripts/check-mobile-version.sh` enforces this — `make pre-push` and the
`mobile:version-pin` CI job both run it, and it fails on a version other than
`0.0.0` in the manifest **or** either of the lockfile's two version fields, and
on `release.sh` growing a `bump_manifest packages/mobile/` line. That is a gate
rather than a comment on purpose: the version did not come from `release.sh`, so
a note there could not have stopped it. **When mobile actually ships (#1599),
delete the gate and add the manifest to `release.sh` — do not raise the pin.**

## What exists, and what is only a type

| Path | State |
|---|---|
| `src/App.tsx`, `src/navigation/` | **Implemented.** Five-tab bottom-tab shell (My Work / Time / Projects / Schedule / Settings), one native stack per tab, stable `testID`s. |
| `src/features/*/` | **Placeholder.** One `Screen` per tab rendering a title and a subtitle. No data, no network. |
| `src/components/Screen.tsx`, `src/theme/` | **Implemented.** Safe-area screen primitive and the typed token bridge. |
| `src/db/schema.ts` | **Typed boundary only.** The `VersionedRecord` contract and the collection-name union. No WatermelonDB schema, no models, no database (#41). |
| `src/sync/index.ts` | **Typed boundary only.** The `SyncEngine` interface and the pull/push payload shapes. No client implements it; nothing calls the server (#41). |
| `src/auth/secureTokenStore.ts` | **Typed boundary with an in-memory stand-in.** `createMemoryTokenStore()` is **not secure and not persistent**. The Keychain/Keystore implementation (`expo-secure-store`) arrives with the auth feature. |
| `src/api/index.ts` | **Typed boundary only.** A base-URL/timeout config object. There is no HTTP client. |

There are no native projects. `android/` and `ios/` do not exist, so the
scaffold cannot be built, installed, or launched on a device or emulator.

## No test suite

There is none, and CI runs none. `mobile:lint` and `mobile:type-check` are the
only gates, and both are scoped to `src/`.

A Detox scaffold (`.detoxrc.js`, `e2e/setup.ts`, six flow files) was removed in
#3367: five of the six flows were `describe.skip` with comment-only bodies, the
sixth could not run — `detox` was never in `devDependencies`, and `.detoxrc.js`
pointed at APKs under the `android/` directory that does not exist. Nothing
linted or type-checked the tree, so it could not even be kept honest. **#1599
restores it together with the native projects that make it runnable.**

**A precondition on #1599, not an afterthought:** `eslint.config.mjs` scopes to
`src/**/*.{ts,tsx}` and `tsconfig.json` includes only `nativewind-env.d.ts` and
`src`, so a restored `e2e/` tree matches *neither* — which is how six files rotted
here unobserved. `packages/web` had the identical hole and closed it with an
`e2e/**/*.ts` eslint block checked against a `tsconfig.e2e.json` (see the root
CLAUDE.md — `@typescript-eslint/no-floating-promises` on un-awaited Playwright
calls is the rule that earns it). Restoring `e2e/` here without doing the same
just resets the clock. No eslint block is added now, deliberately: a config
matching zero files is dead config, and it belongs in the MR that brings the tree
back.

`eas.json` went with it. EAS Build remains the intended build service for both
platforms (ADR-0026 §Build + CI), but its profiles configure builds of
`android/` and `ios/`, no `eas-cli` was installed to read them, and the file's
`channel` keys declared `expo-updates` OTA channels that ADR-0026 explicitly
rejects for enterprise app-store-only compliance. `eas build:configure`
regenerates it — minus the OTA channels — when the native projects land.

## Not Expo managed

Bare React Native (ADR-0026 §Platform, not part of that ADR's supersession —
see References): WatermelonDB and the WASM scheduler need native
modules, and OTA updates are incompatible with app-store-only enterprise
releases. Expo *modules* are used à la carte and EAS *Build* is the build
service; neither makes this an Expo-managed app. Today the package has **no
Expo dependency at all** — `expo-secure-store` arrives with the auth feature.

## Design tokens are not in parity with web

`tailwind.config.js` and `src/theme/tokens.ts` both read
`packages/web/brand/tokens.json`, but `packages/web/tailwind.config.ts` imports
nothing from it. Web's shipped semantic colors are CSS custom properties in
`packages/web/src/styles/globals.css` and have diverged from that file — notably
the warning weight, which web replaced as a WCAG 1.4.3 failure (#1377). Editing
`tokens.json` reskins mobile only.

## The sync types are hand-written, and will not stay that way

`SyncedTable` in `src/db/schema.ts` is transcribed by hand from
`ProjectSyncView.sources` in
`packages/api/src/trueppm_api/apps/sync/views.py`. It has already drifted once —
it named a collection `project_members` that the server calls `memberships`, and
listed 3 of 15.

The intent is to derive it rather than transcribe it, but **`docs/api/openapi.json`
cannot supply it today**: `SyncPullResponse.changes` is declared
`additionalProperties: {}` with the prose description "Per-collection WatermelonDB
buckets", so the pull collection names never reach the published schema. (The
upload side does name `tasks`, via `SyncUploadChangesRequest`.) Deriving the union
is therefore blocked on the server publishing the pull collection keys — API work,
not client work. Until then the union is hand-maintained and can drift again; treat
it as a convenience, not a contract, and check it against `views.py` when you touch
it.

## Platform priority

Android phones first, Android tablets second, iPhone deferred to 1.0 GA. The
roadmap is the source of truth for this ordering and for the milestone — native
Android is **0.6**; ADR-0026's own "Android 0.4 / iOS 1.0" text is the part of it
that was superseded. Mobile is on the 1.0 critical path.

## Local commands

```bash
npm ci
npm run lint        # eslint src/
npm run typecheck   # tsc --noEmit
```

`npm start` / `npm run android` / `npm run ios` are declared but cannot succeed:
there are no native projects.

## References

ADR-0026 (platform decision — **Status: Superseded (2026-05-31)**, but only on
the Detox iOS+Android E2E scope and milestone ordering, which the roadmap now
owns; still the authority on bare RN, à-la-carte Expo modules, and EAS Build) ·
ADR-0191 (scaffold blueprint; amended 2026-09-04 by #3367) · #41 (offline store
+ sync adapter) · #1599 (test suite + native projects) · #3367 (this
correction).
