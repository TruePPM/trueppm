# ADR-1523: Installable PWA shell — service-worker caching, scoped offline surface, and iOS install UX

## Status

Accepted (2026-11-27)

> **Implementation status (2026-11-27):** Decisions 1–3 (tooling, caching, manifest and
> launch) are built in `packages/web` (`vite.config.ts`, `src/lib/pwa/`,
> `src/features/pwa/PwaSplash.tsx`, `index.html`, `e2e/pwa-shell.spec.ts`). Decisions 4–7
> are not built yet. Verified before this work, on `main` at `7241dbf54`: `packages/web` had
> no manifest, no service worker and no `vite-plugin-pwa`; `index.html` pointed
> `apple-touch-icon` at an SVG, which iOS ignores; the only offline UI was the static
> `src/features/shell/OfflineBanner.tsx`. ADR-1463 (Web Push) and ADR-1465 (schedule
> outbox) are Proposed and both assumed a service worker that did not exist.

## Context

Layer: **Operations** (one contributor's own time entries and task status) with a read of
**Programs and Projects** data (My Work). Epic #1393; this record is #1424.

**The PWA is the mobile product, not a stopgap.** #1393 and its children were written when
0.4 was to ship a native Android app (ADR-0026) and iPhone was to go native at 1.0, so the
PWA was framed as an iPhone bridge. ADR-0026 was amended on 2026-09-16 (#3834): native
mobile left the roadmap, and the installable PWA is the mobile story through 1.0, on every
phone. That changes three things the child issues assumed:

- **It is not iPhone-only.** The same manifest and worker make the app installable from
  Android Chrome, which has its own install affordance. Only the *nudge* is iOS-specific,
  because iOS Safari is the one mainstream browser with no `beforeinstallprompt` and no
  install button of its own.
- **There is no native app to be "parity with".** The narrow scope (read My Work, log
  time, change a task's status) is kept on its own merits — it is the job-site minimum
  (ADR-0220's construction-site case), and each further offline surface needs its own
  conflict story — not because a native app will cover the rest later.
- **Other offline work lives inside this shell.** ADR-0220 (board card status), ADR-0247
  (blocker flag) and ADR-1465 (schedule edits) are per-surface offline paths; ADR-1463
  (Web Push) needs a registered worker. All four named "the service worker" without any
  record introducing one. This ADR is that record.

Forces:

- **The server is authoritative** (ADR-0599). Anything the client shows offline is a
  stand-in, labeled as such, and every write is re-authorized on replay.
- **Tokens never persist** (#897). The access token lives in memory, the refresh token in
  an httpOnly cookie; `trueppm-auth` in `localStorage` holds only the `isAuthenticated`
  hint. Nothing in this ADR may weaken that.
- **Rolling upgrades** (ADR-1249). A client can hold the previous release's `index.html`
  while the server has moved on; the image keeps the previous release's hashed assets so
  that client does not blank-screen. A worker that pinned a stale shell, or reloaded a
  page under a user mid-edit, would undo that.
- **CSP** is `script-src 'self'` with no `worker-src`, so a same-origin worker script is
  permitted and nothing inline is.

## Decision

### 1. Tooling: `vite-plugin-pwa` (Workbox), `generateSW`, one worker at `/sw.js`

- `vite-plugin-pwa` 2.x (MIT, Workbox 7, MIT) as a **devDependency**. It generates
  `sw.js` and `manifest.webmanifest` at build time; the shipped worker contains only
  Workbox's precaching and routing modules.
- `generateSW` strategy now. When ADR-1463 adds a `push` handler, the build moves to
  `injectManifest` with a hand-written worker that imports the same precache list; the
  URL (`/sw.js`) and scope (`/`) do not change, so no client re-registers.
- **One worker, scope `/`.** ADR-1463 (push) and ADR-1465 (Background Sync) extend this
  worker; neither registers a second one.
- `injectRegister: false`. Registration is our own module
  (`src/lib/pwa/registerServiceWorker.ts`) so it can be guarded (below) and so an update
  never reloads the page.
- **Never in dev or tests.** The worker is not built in `vite dev` (`devOptions` off — it
  would cache-poison HMR), registration is a no-op without `navigator.serviceWorker` or
  when `import.meta.env.DEV`, and Playwright blocks workers by default
  (`serviceWorkers: 'block'`) so a precache can never sit between a spec and its
  `page.route` mocks. The PWA spec opts back in for itself.

### 2. Caching: precache the shell, cache **no** API response in the worker

| Request | Worker behavior |
|---|---|
| Build output: `index.html`, every `/assets/*` JS/CSS chunk, `/fonts/*`, icons, `theme-init.js`, `boot-guard.js`, the manifest | **Precache**, revisioned by Workbox, cleaned up on activate (`cleanupOutdatedCaches`) |
| Navigation to an app route | **Precached `index.html`** (Workbox `NavigationRoute`) |
| Navigation under `/api/`, `/ws/`, `/admin/`, `/static/`, `/media/`, and the build sentinels (`/asset-manifest.json`, `/asset-files.json`) | **Not handled** (denylist) — the browser goes to the network as if no worker existed |
| `/api/**` (any method), WebSocket | **Not handled.** No runtime cache route is registered for the API at all |

Every route chunk is precached, not only the entry, so the *code* for any route loads
offline; "not cached" (Decision 5) is a statement about *data*.

**Rejected: stale-while-revalidate for API reads in Cache Storage** (the shape #1424's
body proposed). Cache Storage is keyed by URL, not by the `Authorization` header, so two
users on one browser profile share entries; it survives logout unless something
remembers to delete it; any same-origin script can read it; and a worker-served stale
response is indistinguishable, to the page, from a live one, so the page cannot say
"cached at 9:14". The offline read lives in page-owned IndexedDB instead (Decision 4),
which is bound to a user, timestamped, and purged on logout.

The worker never sees a token: it handles no `/api/` request, so neither the
`Authorization` header nor the refresh-cookie response passes through it.

**Updates never reload the page.** The new worker calls `skipWaiting()` and
`clients.claim()`; the page does not listen for `controllerchange` and does not reload.
An open tab keeps running the JS it booted with — including any in-memory paused
mutation `PendingWritesGuard` is protecting — and picks up the new shell on its next
navigation. A lazy chunk that tab asks for is not in the new precache, so it goes to the
network, where the ADR-1249 previous-asset window serves it. The page calls
`registration.update()` hourly and on returning to the foreground, so an installed app
that is never closed still updates.

**Kill switch.** Any API response carrying `X-TruePPM-Service-Worker: disable` makes the
page unregister every worker on the origin and delete its caches (the API client's
response interceptor calls `disableServiceWorker()`). It needs no API code: an operator
adds the header at their ingress or in the chart's web nginx `location /api/` block. It
is the escape hatch for a worker bug that pins clients, which a redeploy alone cannot
fix for a client that never fetches the new `sw.js`. ADR-1463 and ADR-1465 referred to
"the server kill-switch header"; this is its name and contract.

### 3. Manifest, icons and launch

- `name` / `short_name` **TruePPM**, `id` and `start_url` `/`, `scope` `/`,
  `display: standalone`, `theme_color` and `background_color` `#1B2A4A`, `lang: en`.
  `start_url: /` lets the existing landing logic (`features/me/landing.ts`) choose the
  first page, as a browser visit does.
- Icons are PNG, generated from `public/app-icon.svg` by a committed script:
  192 and 512 `purpose: any`, 512 `purpose: maskable` (full-bleed background, the glyph
  already inside the 80% safe zone), and a 180×180 opaque **`apple-touch-icon.png`**.
  The current `apple-touch-icon` points at an SVG, which iOS ignores, so a Home Screen
  icon today is a page screenshot.
- iOS meta: `apple-mobile-web-app-capable` (and `mobile-web-app-capable`),
  `apple-mobile-web-app-title` "TruePPM", status bar style **`default`**.
  `black-translucent` would draw the page under the status bar and needs safe-area
  padding in the shell chrome; that is a layout change this decision does not make.
- **Launch splash is in-app, not `apple-touch-startup-image`.** iOS wants one startup
  image per device size and orientation (more than twenty, and stale with every new
  device). Instead `PwaSplash` — wordmark, tagline, spinner and `v<version> · restoring
  session` — renders **only in standalone display mode**, while the session restores
  (the auth store is hydrating). A browser tab keeps today's behavior.

### 4. Offline read: a user-bound My Work snapshot

- The floor is **My Work** (`/me/work`), the surface a contributor opens on a phone.
- On each successful `/me/work/` fetch the page writes the loaded pages to IndexedDB
  (`trueppm-pwa` database, `myWorkSnapshot` store) with `userId` and `savedAt`.
- When the query fails with a **network error** (no HTTP response) the page renders the
  snapshot under the offline banner, with the time it was saved. A 4xx/5xx response is a
  real answer and is never replaced by the snapshot.
- **Bound to the user.** The snapshot is purged on logout, on user switch (the
  `/auth/me/` id differs from the snapshot's `userId`), and after **7 days**. A cold
  offline launch shows it only when the persisted `isAuthenticated` hint is true — the
  same trust the shell already places in that hint — because no identity can be
  confirmed without a network.
- Not cached: everything else. The board keeps its own ADR-0220 snapshot.

### 5. "This view isn't cached"

`OfflineMiss` ("This view isn't cached — The full schedule needs a connection. Your tasks
and time tracking still work offline." · **Back to My Work** · **Retry connection**)
replaces the page body only when **both** hold: the app booted with no network (a cold
offline launch, so no page has in-memory data to lose), and the route is not one of the
offline-capable routes (`/me/work`, and the board routes ADR-0220 serves). A warm session
that loses its connection keeps whatever each page already has on screen — replacing a
loaded schedule with a fallback would be a regression for every desktop user whose Wi-Fi
drops. It mounts inside the shell's `<main>`; no chrome changes.

### 6. Offline writes: the PWA outbox, two kinds

ADR-1465 decided that the web gets **one** outbox, generalizing ADR-0220 and ADR-0247,
rather than a third bespoke queue. That outbox is not built. This ADR builds its store
with the two kinds the PWA needs; ADR-1465 adds the schedule kinds to the same store.

- **Store:** IndexedDB `trueppm-pwa` → `outbox`, entries `{id, kind, userId, createdAt,
  state, attempts, payload}` replayed **oldest first**. Purged on logout and user switch.
- **`log_time`** → `POST /tasks/{id}/time-entries/` with an **`Idempotency-Key` minted
  when the entry is queued** (the view carries `IdempotencyMixin`, ADR-0170), so a replay
  after a lost response does not double-log. The key only lives
  `IDEMPOTENCY_RETENTION_HOURS` (24 h), so the entry TTL is **24 h**: an older entry is
  marked **Expired — not sent** and waits for the user to send or discard it, because a
  blind replay past the window could log the same hours twice.
- **`set_status`** → `PATCH /tasks/{id}/ {status}` with `X-Source: my_work` and
  **`X-Base-Version`** = the task's `server_version` when queued (ADR-0217). A 409
  `MergeConflict` marks the entry **Conflict** and is not retried; the server's value
  stands. A second offline status change on the same task replaces the first (last write
  wins on this device, the ADR-0220 rule).
- **Lifecycle:** Pending → Syncing → Synced (removed after the banner reports it), or
  Failed (4xx other than 409, including a 403 for a role lost while offline) / Conflict /
  Expired, each kept until the user acts. 429 and 5xx back off and stay Pending.
- **Authority is never cached** (ADR-1465 §4): replay uses the live session, so it waits
  for a successful refresh; an agent or token caller can never replay a human's queue.
- Replay starts on the `online` event and on app start. Background Sync is ADR-1465's
  addition; iOS Safari does not support it, so the page-owned drain is the baseline on
  the platform this epic exists for.
- **Every other write stays online-only**, with today's behavior.

### 7. iOS install nudge

- **Shown** only when all hold: iOS or iPadOS (an iPad reports `MacIntel` with touch
  points), **Safari** (not `CriOS`/`FxiOS`/`EdgiOS`, not an in-app browser such as
  `FBAN`/`Instagram`/`Line`, where Add to Home Screen is unreachable or lands in the wrong
  browser), **not already standalone** (`navigator.standalone` or
  `display-mode: standalone`), and the user is signed in (it mounts in `AppShell`).
- **Never** on desktop or Android; Chrome's own install UI covers Android, and
  `beforeinstallprompt` is not captured.
- **Not nagware:** "Not now" hides it for **30 days**; a second "Not now" hides it for
  good. Stored in `localStorage` (`trueppm.pwa.installNudge`), read and written inside
  `try`/`catch` so a private window just shows it again.
- **"Show me how"** expands two numbered steps (tap Share, then Add to Home Screen) and
  says what iOS will show next. It does not render or script the native sheets.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Hand-written worker over `dist/asset-files.json` | No new dependency | Precache revisioning, cleanup and navigation fallback are exactly where hand-written workers fail; Workbox is the de-facto implementation |
| Runtime SWR cache for `/api/me/work/` in Cache Storage | Offline read with no page code | Not user-bound, survives logout, indistinguishable from live data (Decision 2) |
| `registerType: 'autoUpdate'` with the plugin's register script | Zero registration code | It reloads the page when a new worker takes control — under a user mid-edit |
| `apple-touch-startup-image` per device | Native-looking iOS splash | 20+ images, stale with every device; an in-app splash covers the restore |
| Capture `beforeinstallprompt` for a custom Android button | One install UX everywhere | Chrome already offers install; more UI for no gap |
| A third bespoke queue for time entries | Fastest | ADR-1465 already decided against it |

## Consequences

- Easier: the app installs on iPhone and Android, boots with no signal, and the outbox
  ADR-1465 needs exists, with the user binding and purge rules it requires.
- Harder: a worker is a new version-skew surface; it is mitigated by never reloading,
  the ADR-1249 window, and the kill-switch header.
- Risks:
  - **Shared devices.** The snapshot and outbox belong to the last signed-in user until
    logout. Same exposure ADR-1465 accepted; the purge rules are what bound it.
  - **iOS storage eviction.** Safari may evict a non-installed site's storage after seven
    days without use. The outbox shows its count in the banner so loss is not silent;
    installing to the Home Screen exempts the app from that eviction.
  - **Precache size.** Every chunk is precached on first visit; the build fails if a
    single file exceeds Workbox's size limit rather than silently skipping it.

## Implementation Notes

- P3M layer: Operations (time entry, status) and Programs and Projects (My Work read).
- Affected packages: web, docs. The chart is unchanged (the kill-switch header is
  operator configuration).
- Migration required: no.
- API changes: no. Reuses `POST /tasks/{id}/time-entries/` (Idempotency-Key),
  `PATCH /tasks/{id}/` (`X-Base-Version`, 409 `MergeConflict`), `GET /me/work/`.
- New dependency: `vite-plugin-pwa` (devDependency, MIT).
- OSS.

### Durable Execution
1. Broker-down behavior: N/A — no server-side async work; replayed writes are ordinary
   synchronous requests.
2. Drain task: N/A on the server. The page drains the outbox on `online` and on start.
3. Orphan window: N/A.
4. Service layer: the existing time-entry and task write paths; no new server path.
5. API response: unchanged (201 for a time entry, 200/409 for the PATCH).
6. Outbox cleanup: Synced entries are removed; Failed/Conflict/Expired stay until the
   user acts; everything is purged on logout or user switch.
7. Idempotency: `log_time` carries an Idempotency-Key minted at queue time and expires
   with the server's 24 h retention; `set_status` carries `X-Base-Version`, so a
   duplicate replay is a no-op or a reported conflict.
8. Dead-letter: the banner's "needs attention" count and the per-entry state are the
   dead-letter view; 429/5xx retry with backoff.

### On Acceptance
- [x] Sweep `--adr 1523` (2026-11-27): **0** open issues name this ADR (it is new).
- [ ] Hand check of the epic's children, which predate it: #1425 ("stale-while-revalidate
      for cached read routes") and #1424 (decision 1, "stale-while-revalidate for cached
      reads") carry the option Decision 2 rejects; #1426 and #1427 match. **2** bodies to
      correct with a dated note. Not done on this branch (the implementing session had no
      tracker write access).
- [ ] Mark ADR-1463 and ADR-1465 as extending this worker and outbox store.
