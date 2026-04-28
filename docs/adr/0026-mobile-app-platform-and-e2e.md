# ADR-0026: Mobile app platform and E2E testing strategy

## Status
Proposed

## Context

Issue #42 originally required mobile E2E coverage via Detox (iOS + Android) as part
of the test-suite ticket. No `packages/mobile/` exists in the monorepo yet, so Detox
scenarios are architecturally impossible to write today.

The VoC panel (6.8/10 build vs 3.8/10 drop) made the priority clear:

- **Sarah (PM) 10/10 "Build mobile"** — "This is the whole reason I would switch
  tools. I'm on a construction site 3 days a week. If 'mobile' means a responsive
  web page, I'm out."
- **Priya (Team Member) 9/10** — "I log time from the train. A web page that kinda
  works on Safari is not a mobile app."
- Marcus/David/Janet indifferent on build-vs-drop, but Marcus flagged "fine, as long
  as the mobile roadmap has a date. Open-ended 'future issue' is how features die."

Mobile is a first-class brand promise, not a sub-bullet of a coverage ticket.
Architect review split #42: close the web+API scope there; open mobile as its own
milestone-scoped initiative with this ADR.

**P3M layer**: Programs and Projects + Operations (Sarah's single-project schedule
management and Priya's time entry). **OSS.**

## Decision

### Platform

**React Native 0.76+ with the New Architecture (Hermes + TurboModules).** Bare
workflow (not Expo managed) because:

1. Offline-first requires WatermelonDB, which needs native module support Expo
   managed does not provide without ejecting.
2. WASM scheduler (via JSI, per ADR-0015 original plan) needs native modules.
3. Expo managed's OTA update model is incompatible with enterprise customers who
   need app-store-only releases for compliance.

**NativeWind** for styling (Tailwind-compatible tokens — shares design-system v1.0
tokens with web).

**Expo modules** are used à la carte (camera, file system, notifications) but the
core shell is bare RN.

### Package layout

```
packages/mobile/
├── package.json
├── metro.config.js
├── babel.config.js
├── tsconfig.json
├── app.json
├── ios/                    # Xcode project
├── android/                # Gradle project
├── src/
│   ├── db/                 # WatermelonDB schema + models
│   ├── sync/               # Pull/push engine, outbox queue
│   ├── features/
│   │   ├── projects/       # Project list + detail
│   │   ├── tasks/          # My tasks + task detail
│   │   ├── time/           # Time entry (Priya's core flow)
│   │   ├── schedule/       # Read-only Schedule view on phones; editable on tablet
│   │   └── settings/
│   ├── auth/
│   ├── api/                # Shared OpenAPI-derived types (symlinked from web)
│   └── App.tsx
├── e2e/                    # Detox tests
│   ├── jest.config.js
│   ├── .detoxrc.js
│   └── flows/
│       ├── offline-time-entry.e2e.ts
│       ├── online-task-update.e2e.ts
│       ├── sync-after-reconnect.e2e.ts
│       └── gantt-read.e2e.ts
└── __tests__/              # Jest unit tests
```

### Data layer — WatermelonDB (per CLAUDE.md constraint)

- Schema mirrors the server `VersionedModel` contract — every synced entity has
  `id` (UUID), `server_version` (BigInt), `is_deleted`.
- `sync/` implements the `/api/v1/sync/pull?last_version=...` + `/api/v1/sync/push`
  protocol already specified in CLAUDE.md.
- Outbox queue for writes made while offline. Replays on reconnect.
- No direct SQLite, no Realm, no PowerSync (per CLAUDE.md).

### Authentication

- JWT access + refresh tokens stored in `expo-secure-store` (iOS Keychain, Android
  Keystore).
- Biometric unlock (Face ID / fingerprint) optional, off by default.
- Deep-link handler for invite tokens.

### Build + CI

- **iOS**: fastlane + EAS Build (Expo Application Services) for signing. TestFlight
  distribution for internal testing.
- **Android**: Gradle + EAS Build. Internal track on Play Console for testing.
- CI job `mobile:test` runs Jest + TypeScript check on every PR
- CI job `mobile:e2e:ios` and `mobile:e2e:android` run on **nightly** schedule
  (Detox on managed runners is slow; per-PR gating blocks velocity). PR-gated
  Detox smoke (1 critical flow) runs on pull requests.
- **Release cadence**: track the web release cadence. No independent mobile
  versioning in v1.

### Detox E2E scope

Minimum flows for ADR sign-off:

1. **Offline time entry (Priya's core flow)**: airplane mode → log 2h against a
   task → reconnect → assert time entry appears on server via API poll.
2. **Online task update**: open a project → change task status → assert WS event
   received and UI updates.
3. **Sync after reconnect**: stale 24h cache → reconnect → assert server data
   pulled, local changes pushed, no duplicates, no lost writes.
4. **Schedule view read on phone**: load project with 100 tasks → scroll Schedule view → assert
   no crash, critical path visible, dependency arrows render.
5. **Auth flow**: login → receive tokens → backgrounded app for 1h → foreground →
   token refresh silent, session survives.

Each flow tests both iOS and Android on every nightly run.

### Performance targets (mobile)

| Metric | Target | Measured by |
|---|---|---|
| Cold start to home screen | < 2s on iPhone 12 / Pixel 6 | Detox timing + Flashlight |
| Project list (100 projects) | < 500ms from cache | Detox timing |
| Task list (500 tasks) | < 1s from cache | Detox timing |
| Time entry submit (online) | < 300ms to acknowledgment | Detox timing |
| Sync pull (10k version delta) | < 5s | Detox + synthetic fixtures |
| Crash-free sessions | ≥ 99.5% | Sentry mobile SDK |

### Milestone

**Target milestone: v1.0** (est. next major release after Wave 3 ships). Not
open-ended — Marcus's 6/10 was explicitly conditional on a date.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **React Native bare + WatermelonDB** (chosen) | Offline-first; native perf; WASM/JSI possible; matches CLAUDE.md constraints | Bare workflow adds ops overhead (Xcode/Gradle) vs Expo managed |
| Expo managed + SQLite | Fastest scaffold; no Xcode/Gradle | No WatermelonDB without ejecting; no WASM/JSI; OTA update model breaks enterprise |
| Flutter + Isar | Great perf; Isar is fast | Second language (Dart); no code sharing with web; smaller contributor pool; against CLAUDE.md tech-stack direction |
| PWA + web responsive layout | Zero new package | Fails Sarah's 10/10 requirement; no real offline; no native notifications; no biometric; app-store presence required for enterprise |
| Native iOS + Android separately | Best per-platform UX | Two codebases; disqualifying maintenance cost |

**Why not Capacitor / Ionic?** WatermelonDB is a constraint; Capacitor's SQLite
plugins are adequate but WatermelonDB is the canonical choice in CLAUDE.md.

## Consequences

### Easier
- Sarah's and Priya's core flows (offline time entry, job-site schedule update) ship.
- Brand promise ("offline-first mobile") is backed by shipping code, not marketing.
- WASM scheduler has a second consumer (web + mobile) — amortizes the Rust
  maintenance cost called out in ADR-0015.

### Harder
- Monorepo grows by a package with its own build toolchain (Xcode, Gradle, EAS).
- Sync protocol (`pull`/`push`) must be rigorously versioned — mobile clients live
  longer than server releases. Breaking the protocol breaks apps already installed.
- E2E test matrix doubles: every server PR can break mobile if the serializer
  contract changes. Mitigated by contract tests (OpenAPI schema diff in CI) and
  nightly Detox runs.
- Two app-store submission pipelines (Apple + Google). Submission, review, rollback
  are ops work that CI cannot fully automate.

### Risks
- **New Architecture maturity**: RN 0.76 New Architecture is still stabilizing in
  2026. Fallback: disable New Architecture per-module if stability issues surface
  (`newArchEnabled: false` for specific native modules).
- **WatermelonDB schema migrations on mobile are hard**: bad migration bricks
  every user's app until a new release ships. Mitigation: staged rollout (TestFlight
  + Play internal track first), schema version guardrails in CI (no destructive ops
  without explicit migration script).
- **Detox flakiness**: the framework is notorious for CI instability on Android
  emulators. Mitigation: nightly schedule absorbs flakes; retry-on-failure at the
  CI job level (max 2 retries).

## Implementation Notes

- **P3M layer**: Programs and Projects (Sarah) + Operations (Priya)
- **Affected packages**: `mobile` (new), `api` (no change — sync protocol already
  exists per CLAUDE.md), `web` (no change — design tokens are shared via Tailwind
  config, not imported)
- **Migration required**: no (server unchanged; mobile is greenfield)
- **API changes**: no (uses existing `/api/v1/sync/pull`, `/api/v1/sync/push`,
  `/api/v1/auth/*`)
- **OSS or Enterprise**: **OSS** (`trueppm-suite`)
- **Target milestone**: v1.0

### Durable execution checklist

Not applicable to client code. Server-side sync endpoints already use the
transactional outbox pattern per `project_durable_execution` convention.

### Implementation order

1. Scaffold `packages/mobile/` with RN 0.76 bare + NativeWind + TypeScript strict
2. WatermelonDB schema + models (mirror server `VersionedModel` contract)
3. Sync engine: pull/push against existing API endpoints
4. Auth + JWT storage + refresh flow
5. Project list + task list + task detail (read-only)
6. Time entry (write + offline queue) — Priya's flow
7. Read-only Schedule view (canvas, reuse web renderer where possible via React Native Skia)
8. Detox E2E suite (5 flows above)
9. EAS Build + CI integration
10. Alpha to internal testers via TestFlight / Play internal track

### Related ADRs

- ADR-0015: WASM CPM Engine — mobile inherits the original integration plan via JSI
- ADR-0020: Long-Running Task Progress Tracking — mobile subscribes to `task_run_*`
  WebSocket events for in-progress uploads and syncs
- ADR-0023: Actual Start and Finish Dates on Tasks — mobile time entry feeds
  actual dates back to server

### Follow-up issues

- Mobile Schedule view editable interactions (drag, preview) — after read-only ships
- Push notifications — after auth + sync stable
- Biometric unlock toggle — post-MVP
- iPad tablet layout (split-view Schedule + task list) — post-MVP
