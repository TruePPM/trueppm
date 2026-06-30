# ADR-0191: Mobile app scaffold implementation plan (`packages/mobile/` + Detox E2E)

> **This ADR records the implementation plan for the mobile platform decision in
> [ADR-0026](./0026-mobile-app-platform-and-e2e.md).** ADR-0026 is the authoritative
> platform decision; this ADR is its concrete scaffold blueprint. Where this plan
> and an issue disagree, **ADR-0026 wins** and the issue is corrected, not this ADR.
> This document is the scaffold blueprint for issue **#94** (`packages/mobile/`
> scaffold + Detox E2E, React Native bare), the foundation the 0.4 mobile track
> builds on.

**Status:** Accepted (scaffold landed for #94 — bare RN app skeleton,
5-tab navigation spec, design-token parity, and the `mobile:lint` /
`mobile:type-check` CI gates; native iOS/Android projects, WatermelonDB
(#41), and the Detox e2e suite remain deferred follow-ups).
**Scope:** OSS (`trueppm-suite`, Apache-2.0). Mobile is OSS. **Never** imports
`trueppm_enterprise`.
**Owns:** issue #94. **Feeds:** #41 (WatermelonDB schema + sync adapter), #23
(scaffold — see reconciliation below).

---

## 1. Bare RN vs Expo — reconciled against ADR-0026

### What ADR-0026 actually mandates

ADR-0026 §Platform is unambiguous:

> **React Native 0.76+ with the New Architecture (Hermes + TurboModules). Bare
> workflow (not Expo managed)** because: (1) WatermelonDB needs native modules
> Expo managed cannot provide without ejecting; (2) the WASM scheduler (JSI, per
> ADR-0015) needs native modules; (3) Expo managed's **OTA update model is
> incompatible with enterprise customers** who need app-store-only releases for
> compliance.

But the same ADR also explicitly allows two Expo *tools* inside a bare app:

> **Expo modules are used à la carte** (camera, file system, notifications) but
> the core shell is bare RN.

…and under §Build + CI it uses **EAS Build** for both platforms (`Gradle + EAS
Build`, `fastlane + EAS Build for signing`).

**The reconciled truth — the line that resolves the contradiction:**

| Dimension | Decision (ADR-0026) | Notes |
|---|---|---|
| Workflow | **Bare RN** (`react-native init` / Community CLI template) | NOT Expo *managed* / prebuild-owned |
| Expo SDK modules | **Yes, à la carte** via `expo-modules-core` (`npx install-expo-modules`) | `expo-secure-store`, `expo-camera`, `expo-file-system`, `expo-notifications` — installed into a bare project, autolinked |
| EAS Build | **Yes** (cloud build service) | EAS Build builds *bare* RN projects; it is a build service, not the managed workflow |
| **Expo OTA / `expo-updates`** | **NO** | Explicitly rejected — breaks enterprise app-store-only compliance |
| `expo start` managed dev server | **NO** (use Metro + RN CLI / `expo-dev-client` if a dev client is wanted) | — |

So "bare RN" and "uses Expo" are **not** contradictory here: bare core shell +
selective Expo *libraries* + EAS *Build* service, with **no OTA updates and no
managed prebuild ownership**.

### Issue alignment

- **#94** ("React Native **bare** + Detox") → ✅ **matches ADR-0026 exactly.**
  This is the ticket this plan implements.
- **#23** ("React Native 0.76+ + **Expo SDK**" … "Expo EAS … and **OTA
  updates**") → ⚠️ **partially contradicts ADR-0026.** The EAS-Build and
  shared-Tailwind-tokens parts are fine and survive; the **"Expo SDK" (managed)
  framing and especially "OTA updates"** directly contradict ADR-0026's decision
  and its stated enterprise-compliance rationale. #23 predates the ADR (labelled
  `phase-2`) and **overlaps #94** — both say "bootstrap `packages/mobile/`". See
  🔴 Blocker B-1 below: these two issues must be reconciled before scaffolding.

**Decision for the scaffold: bare RN, no `expo-updates`/OTA, EAS Build as the
build service, Expo modules à la carte.** Per ADR-0026.

---

## 2. `packages/mobile/` directory structure

Follows ADR-0026 §Package layout verbatim, with the build-tool and config files
a bare RN 0.79+ New-Arch project needs:

```
packages/mobile/
├── package.json              # self-contained (no root npm workspace in this monorepo)
├── app.json                  # RN app config (name, displayName)
├── index.js                  # AppRegistry entry
├── metro.config.js           # Metro + WatermelonDB/NativeWind transformer wiring
├── babel.config.js           # nativewind/babel + reanimated plugin (must be last)
├── tsconfig.json             # strict; extends a shared base; "@/*" + "@api/*" paths
├── tailwind.config.js        # imports the SAME design tokens as packages/web (parity)
├── .detoxrc.js               # Detox configurations (android.emu.* / ios.sim.*)
├── eas.json                  # EAS Build profiles (development / preview / production)
├── .eslintrc.cjs             # extends the repo TS/React eslint config
├── ios/                      # Xcode project — STAYS COMPILABLE through 0.4 (ADR constraint)
├── android/                  # Gradle project — primary 0.4 platform
├── src/
│   ├── App.tsx               # NavigationContainer + bottom-tab shell
│   ├── db/                   # WatermelonDB schema + models  → filled by #41
│   ├── sync/                 # pull/push engine + outbox     → filled by #41
│   ├── api/                  # OpenAPI-derived types, shared with packages/web (see §6)
│   ├── auth/                 # JWT storage (expo-secure-store) + refresh
│   ├── navigation/           # React Navigation stacks + bottom-tab definitions
│   ├── components/           # shared NativeWind primitives
│   └── features/
│       ├── projects/         # project list + detail
│       ├── tasks/            # My Tasks + task detail
│       ├── time/             # time entry (Priya's core flow)
│       ├── schedule/         # read-only Schedule view (RN Skia) on phone
│       └── settings/
├── e2e/                      # Detox
│   ├── jest.config.js
│   ├── setup.ts
│   └── flows/
│       ├── app-launch.e2e.ts            # ← FIRST smoke (PR-gated, see §4)
│       ├── offline-time-entry.e2e.ts    # nightly (ADR flow 1)
│       ├── online-task-update.e2e.ts    # nightly (ADR flow 2)
│       ├── sync-after-reconnect.e2e.ts  # nightly (ADR flow 3)
│       ├── schedule-read.e2e.ts         # nightly (ADR flow 4)
│       └── auth-refresh.e2e.ts          # nightly (ADR flow 5)
└── __tests__/                # Jest unit tests (component + util)
```

**Scaffold-MR scope (the #94 deliverable):** everything above as a *compiling,
launchable shell* — bottom-tab navigation renders, screens are placeholder
stubs, `db/` and `sync/` exist as empty typed module boundaries (real
implementation is #41). The scaffold must boot to the tab shell on an Android
emulator and pass `mobile:test` (jest + tsc) on both platform targets.

---

## 3. RN version + core dependencies

ADR-0026 floor: **RN ≥ 0.76, New Architecture (Hermes + TurboModules) on.**
At scaffold time, pin the **latest stable 0.7x/0.8x New-Arch release** (≥ 0.79
recommended; confirm the current stable patch the day the scaffold lands and pin
the exact version in `package.json` — do not float).

| Concern | Package | Version (pin at scaffold) | Source / why |
|---|---|---|---|
| Core | `react-native` | ≥ 0.79, New Arch on | ADR-0026 (≥0.76 floor) |
| Runtime | `react` | matches RN's required React | — |
| Offline DB | `@nozbe/watermelondb` | ^0.27 | ADR-0026 + #23 (CLAUDE.md constraint) |
| WDB native | JSI SQLite adapter (bundled) | — | bare-only; the reason Expo managed is rejected |
| Styling | `nativewind` | ^4 | ADR-0026 — shares web's Tailwind tokens |
| Styling peer | `tailwindcss`, `react-native-reanimated`, `react-native-safe-area-context` | current | NativeWind v4 peers |
| Navigation | `@react-navigation/native` + `native-stack` + `bottom-tabs` | ^7 | ADR doesn't name a lib; React Navigation is the RN standard and #23's Tasks/Time/Projects/Settings bottom bar implies it |
| Nav peers | `react-native-screens`, `react-native-gesture-handler` | current | React Navigation peers |
| Secure storage | `expo-secure-store` | current | ADR-0026 (JWT → Keychain/Keystore) — à-la-carte Expo module |
| Expo modules core | `expo`, `expo-modules-core` | current | enables à-la-carte modules in a **bare** app (`npx install-expo-modules`) |
| Camera / FS / push | `expo-camera`, `expo-file-system`, `expo-notifications` | current | ADR-0026 à-la-carte list |
| Read-only Gantt | `@shopify/react-native-skia` | current | ADR-0026 step 7 (canvas Schedule view) |
| E2E | `detox` | ^20 | ADR-0026 |
| E2E runner | `jest`, `jest-circus`, `@types/jest` | current | Detox test runner |
| Types | `typescript` (strict), `@tsconfig/react-native` | current | CLAUDE.md TS strict, no `any` |

**Explicitly NOT included:** `expo-updates` / any OTA package (enterprise
compliance, ADR-0026 §Platform reason 3); Realm, PowerSync, raw SQLite (ADR-0026
§Data layer); any Android-only native lib that would break the iOS build
(ADR-0026 §Shipping-order constraint — `ios/` stays compilable through 0.4).

---

## 4. Detox config + first E2E smoke test shape

**Config (`.detoxrc.js`):** three configurations —
`android.emu.debug` / `android.emu.release` (Pixel-6-class AVD, the 0.4 baseline
per ADR) and `ios.sim.debug` (best-effort in 0.4, `allow_failure` — required at
1.0 GA). Test runner: Jest (`e2e/jest.config.js`, `jest-circus`), `e2e/setup.ts`
installs the Detox lifecycle hooks.

**Two tiers of flow (matches ADR-0026 §Detox E2E scope + #94 "1-flow PR
smoke"):**

- **PR-gated smoke — ONE flow, backend-free:** `e2e/flows/app-launch.e2e.ts`.
  Cold-launch the app → assert the bottom-tab shell renders and the **Tasks**
  tab is visible and selected within the < 2s cold-start budget. No network, no
  seeded server — it only proves the bare shell boots and navigates. This is the
  flow the scaffold MR delivers and the one wired into the (future)
  per-PR/nightly Android smoke.

  ```ts
  // e2e/flows/app-launch.e2e.ts  (shape, not final)
  describe('app launch smoke', () => {
    beforeAll(async () => { await device.launchApp({ newInstance: true }); });

    it('boots to the bottom-tab shell with Tasks selected', async () => {
      await waitFor(element(by.id('tab-bar')))
        .toBeVisible().withTimeout(2000);          // < 2s cold-start gate
      await expect(element(by.id('tab-tasks'))).toBeVisible();
      await expect(element(by.id('screen-tasks'))).toBeVisible();
    });
  });
  ```

- **Nightly suite — the 5 ADR-0026 flows** (offline time entry, online task
  update, sync-after-reconnect, Schedule read, auth refresh). These need a
  seeded backend, WatermelonDB (#41), and airplane-mode toggling. They are
  **scaffolded as files in the #94 MR but land green incrementally** as #41 and
  the feature work arrive — the scaffold MR is not blocked on them passing.
  Android required nightly in 0.4; iOS nightly `allow_failure: true` in 0.4 →
  required at 1.0 GA.

---

## 5. CI job shape (`mobile:*`) and monorepo wiring

Mobile jobs mirror the existing `.web` pattern (per-package template, `npm ci` in
the package dir, change-gated rules anchor). **There is no root npm workspace** —
each package self-installs, so mobile follows suit.

### New rules anchor (alongside `.rules-web`)

```yaml
.rules-mobile: &rules-mobile
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
      changes:
        - packages/mobile/**/*
        - .gitlab-ci.yml
```

### New template + jobs

```yaml
.mobile:                                   # node-only template — lint/type/jest
  image: node:20-alpine@sha256:...         # same pinned node as .web
  cache:
    key: { files: [packages/mobile/package-lock.json], prefix: mobile-npm-cacache }
    paths: [ .cache/npm/ ]
  before_script:
    - *retry-fn
    - cd packages/mobile
    - retry npm ci --prefer-offline --quiet

mobile:lint:        { extends: .mobile, stage: lint,    <<: *rules-mobile, script: [ npm run lint ] }
mobile:type-check:  { extends: .mobile, stage: analyze, needs: [mobile:lint], <<: *rules-mobile, script: [ npm run typecheck ] }
mobile:test:        { extends: .mobile, stage: test,    needs: [mobile:type-check], <<: *rules-mobile, script: [ npm test ] }
```

`mobile:test` = ADR-0026's "Jest + TypeScript check on every PR (both platforms
must compile)" — the per-PR gate. These three run on standard node runners; **no
emulator needed**, so the scaffold MR is fully gated on the existing shared
runners.

### Nightly Detox jobs (NOT in the scaffold MR — see 🔴 Blocker B-2)

```yaml
mobile:e2e:android:   # nightly, REQUIRED in 0.4; needs an emulator-capable runner
  stage: test
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $MOBILE_E2E == "true"'
  retry: { max: 2 }   # Detox/emulator flake absorber (ADR-0026 §Risks)

mobile:e2e:ios:       # nightly, allow_failure in 0.4 → required at 1.0 GA; macOS runner
  stage: test
  allow_failure: true
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $MOBILE_E2E == "true"'
```

### Makefile wiring

Add per-package targets mirroring the `*-web` set, and a **change-gated**
`pre-push-mobile` that mirrors `pre-push-wasm` (only runs when
`packages/mobile/**` changed vs `origin/main`, skips cleanly when node/deps are
absent — so a non-mobile push stays inside the ~60s pre-push budget):

- `lint-mobile`     → `cd packages/mobile && npm run lint`
- `typecheck-mobile`→ `cd packages/mobile && npx tsc --noEmit`
- `test-mobile`     → `cd packages/mobile && npm test`
- `pre-push-mobile` → change-gated guard, added to `pre-push-checks`

Do **not** add mobile unconditionally to the aggregate `lint:` / `typecheck:` /
`test:` targets (would force every dev to install `packages/mobile`); keep it
change-gated in `pre-push` exactly as `pre-push-wasm` is, and expose standalone
targets for mobile devs.

---

## 6. Sequencing vs #41 (sync adapter) and #23

### Build order (the gate chain for the scaffold itself)

```
architect [platform = ADR-0026, no re-derivation]
  → /voc + ux-design already covered by ADR-0026 VoC panel + mobile-design skill
  → implement scaffold (#94)
  → mobile-review  (touch targets, offline states, platform conventions)
  → test  (mobile:test green: jest unit + tsc both platforms; app-launch smoke)
  → changelog  (changelog.d/94.added.md)
  → /mr
```

### #94 → #41 sequencing (strict prerequisite)

ADR-0026 §Implementation order: **(1) scaffold → (2) WatermelonDB schema +
models → (3) sync engine**. So **#94 (this scaffold) is a hard prerequisite for
#41.** #41 fills `src/db/` (WatermelonDB schema mirroring the server
`VersionedModel` contract: `id` UUID, `server_version` BigInt, `is_deleted`) and
`src/sync/` (pull/push + outbox) — both directories the scaffold creates as empty
typed boundaries. #41 cannot start until `packages/mobile/` exists.

### ⚠️ #41 server-side framing is STALE — the sync API already exists

#41 describes "**Django Sync API (new endpoints)**":
`GET /api/v1/sync/pull?last_version={n}&scope={my_tasks|my_projects|full}` and
`POST /api/v1/sync/push`. **The API already ships a working,
WatermelonDB-formatted, tombstone-carrying sync endpoint** — but at a different
URL/shape:

- `GET  /api/v1/projects/{pk}/sync/?since={server_version}` — `ProjectSyncView`,
  returns all rows (live **and** soft-deleted tombstones) with
  `server_version > since`, formatted for WatermelonDB, per-project, RBAC =
  Viewer+ may pull.
- `POST /api/v1/projects/{pk}/sync/` — push, write-role required, per-row
  idempotency + conflict resolution.
- `POST /api/v1/sync/ws/ticket/` — WebSocket auth ticket.

(Source: `packages/api/src/trueppm_api/apps/sync/{urls,views}.py`.) This matches
ADR-0026's claim that "the sync protocol already exists" and **contradicts #41's
"new endpoints" scope.** The real server-side delta in #41 (if wanted) is narrow:
a **cross-project `my_tasks` pull scope** (the existing endpoint is per-project
only) and the `?since=` vs `?last_version=` param-name difference. **#41's
client-side half** (WatermelonDB schema + adapter that calls the *existing*
`ProjectSyncView`, plus `react-native-background-fetch`) **is the real work** and
depends on #94. → 🔴 Blocker B-3.

### #23 reconciliation

#23 and #94 both "bootstrap `packages/mobile/`" → **overlap.** #94 is the
ADR-0026-aligned ticket (bare + Detox). #23 carries the contradicting Expo-managed
/ OTA framing. Recommended resolution (Kelly's call — Blocker B-1): **make #94 the
canonical scaffold issue; close #23 as superseded-by-#94, OR rescope #23 down to
its still-valid unique pieces** (shared-Tailwind-token parity check + the
Tasks/Time/Projects/Settings bottom-tab spec) as a sub-task under #94. Do not
implement #23's "Expo SDK + OTA updates" as written.

---

## 7. OSS / Apache-2.0 boundary

Mobile is **OSS** (`trueppm-suite`). The scaffold imports only OSS packages and
the existing OSS sync/auth API; it **never** imports `trueppm_enterprise`. Verify
with `grep -r "trueppm_enterprise" packages/mobile/` → must be zero. No enterprise
extension points are touched.

---

## Open items folded up to the return (🔴 blockers for Kelly)

- **B-1 — bare-vs-Expo + #23/#94 overlap.** #23 says Expo SDK + OTA; ADR-0026 and
  #94 say bare + no OTA. ADR-0026 wins. Decide #23's fate (close-as-superseded vs
  rescope) **before** scaffolding so two tickets don't build the same package.
- **B-2 — nightly Detox is blocked by CI infra + the `workflow:` block.** The
  `workflow:` rules (`.gitlab-ci.yml` ~line 107) set `when: never` for every
  scheduled pipeline except `RENOVATE`. The nightly `mobile:e2e:*` jobs need a
  workflow carve-out (`$CI_PIPELINE_SOURCE == "schedule" && $MOBILE_E2E ==
  "true"`) **and** an Android-emulator-capable (KVM) self-hosted runner + macOS
  runner — neither exists on the current shared runners (cf. ADR-0026 risks &
  issues #29/#30). This does **not** block the scaffold MR (`mobile:lint/type-
  check/test` run on standard node runners); it blocks the nightly E2E gate only.
- **B-3 — #41 sync scope is stale.** `ProjectSyncView` already implements the
  pull/push protocol; #41 should be re-scoped to its client-side WatermelonDB
  schema + adapter (against the existing endpoint) plus, optionally, a
  cross-project `my_tasks` pull scope — not net-new pull/push endpoints. #41 is
  blocked-by #94.
- **B-4 (minor) — milestone text drift.** #94's body says "Target milestone:
  v0.6" while its GitLab milestone field and ADR-0026 both say **0.4**. Fix the
  stale body text.
