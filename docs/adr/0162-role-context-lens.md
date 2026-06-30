# ADR-0162: Role-context lens — a presentation-only PM / Scrum Master / Unified view switcher

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: role_context)

## Context

A single person frequently wears two hats: they run the waterfall program **and**
facilitate the agile team — the dual-hat "PM + Scrum Master" delivery lead. TruePPM's
navigation is view-based (Schedule / Board / Sprints / …), so this person pays a
constant context-switching tax: every time they open a project they land on the same
canonical surface (Overview) regardless of which hat they are wearing today.

Issue #412 shipped the **API foundation** for a fix: `profiles.UserProfile.role_context`,
a per-user CharField with choices `pm` / `scrum_master` / `unified` (default `unified`),
writable through `PATCH /auth/me/profile/`. The model docstring explicitly defers "the
concrete mode-layouts that consume it" to a frontend follow-up — this issue (#1263).

This ADR decides **what the lens concretely does to the UI** and bounds v1 so it ships
honestly against surfaces that exist today, without fabricating dashboards that do not.

**P3M layer:** Operations / Programs-and-Projects. The lens is a single-user,
single-project-nav personalization preference — it never aggregates across projects or
programs. It is unambiguously **OSS**, the same tier as the existing `default_landing`
(ADR-0129) and `hidden_views` (ADR-0139) preferences.

**Voice-of-Customer signal** (8-persona panel): loved by the Operations cohort this
serves — Morgan/Agile Coach 8🟢 ("acknowledges one person holds both hats"), Alex/Scrum
Master 7, Priya/Team Member 7 ("leave it on Unified and it disappears"). The low scores
(Janet 2🔴, David 2🔴, Marcus 3) are the Enterprise / out-of-release-window personas this
OSS single-user feature was never meant to serve — they are boundary-confirming, not
feature defects. The panel surfaced one **security-load-bearing** constraint (Morgan):
the lens must never become a backdoor that relaxes permissions.

### Forces at play
- **Must not duplicate or fight `default_landing`** (ADR-0129) — that preference already
  owns "which surface do I land on at `/`". The lens operates *inside the project shell*,
  after landing, on a different axis (which hat, not which front door).
- **Must not edit the canonical view registry** (`viewMeta.ts` / `methodologyTabs.ts`) —
  those modules are consumed by the ⌘K palette and ViewsMenu; a lens layer must compose
  on top, not mutate the source of truth.
- **No flash of the wrong lens** on load — the lens-affected surfaces must read the
  stored value before first meaningful paint, defaulting to the neutral `unified` while
  the `/auth/me/` response is in flight.
- **`role_context` is writable but not readable.** `MeSerializer` (`/auth/me/`) exposes
  `default_landing` and `hidden_views` but **not** `role_context`. The switcher cannot
  reflect or respect the stored lens without a one-field read addition.

## Decision

Implement the role-context lens as a **presentation-only** preference with the following
**headline invariant**:

> **The role-context lens re-orders and re-points already-permitted surfaces for the
> active user only. It NEVER changes RBAC, permissions, write-gating, which data is
> fetched, or any other user's experience. Role-based access control remains the sole
> authority on what a user may see and do. "PM mode" grants zero additional capability
> over "Scrum Master mode."**

v1 delivers four pieces, all OSS / web-only:

### 1. The switcher control (low-noise, personal, invisible to others)
- An inline 3-option segmented control in `features/shell/UserMenu.tsx`, mirroring the
  existing Theme row pattern (a `justify-between` row, label + compact control, **not** a
  `role="menuitem"`). Options: **Unified Today** (default) · **PM** · **Scrum Master**.
- A matching `role="radiogroup"` row on `features/me/MyGeneralPreferencesPage.tsx`,
  mirroring the `default_landing` chooser exactly (optimistic local state → mutate →
  revert on error → `aria-live="polite"` status line).
- Writes via a new `useUpdateRoleContext()` hook (mirror of `useUpdateDefaultLanding`):
  `PATCH /auth/me/profile/ { role_context }`, then `invalidateQueries(['current-user'])`.
  Server enforces choice validation (400 on bad value); the control surfaces the error
  inline and stays re-enabled to retry.

### 2. The `/auth/me/` read addition (the only backend change)
- Extend `profiles/services.py::get_profile_prefs` to project and return `role_context`
  in its tuple (now `(default_landing, hidden_views, role_context)`), and add a
  `role_context` `SerializerMethodField` to `MeSerializer` reading from the same memoized
  single-profile read. **Zero additional DB queries** — `role_context` is a column on the
  `UserProfile` row already fetched. Add `role_context` to the web `CurrentUser` type.

### 3. Lens-chosen default project view (the headline behavior — issue AC)
- Replace the static `{ index: true, element: <Navigate to="overview" replace /> }` at
  the project-shell index (`router.tsx`) with a small `<ProjectIndexRedirect />` that
  reads `role_context` and navigates to the lens-preferred view:
  **PM → `schedule`**, **Scrum Master → `board`**, **Unified → `overview`** (current
  behavior). The preferred targets are universally-present routes (every methodology has
  them), so the redirect always resolves.
- **No-flash:** the component holds (renders nothing / the existing shell skeleton) until
  the `['current-user']` query resolves, then redirects exactly once — mirroring
  `RootRedirect`'s `if (isLoading || !user) return null` pattern. On a warm cache (the
  common case — `TopBar` has already fetched `/auth/me/`) the redirect is synchronous.

### 4. Lens view-bar emphasis (makes the layout visibly "distinct" per the AC)
- A new **pure** module `features/shell/lensOrder.ts` exporting
  `applyRoleContextLensOrder(groups, lens)`, piped into `ViewTabs.tsx` immediately after
  `groupedVisibleViewsForUser(...)`. It promotes the lens-priority views to the **front
  of their existing group** (PM → `schedule`, `grid`; Scrum Master → `board`, `sprints`,
  `product-backlog`) **without** reshuffling across groups, hiding anything, or editing
  `viewMeta.ts` / `methodologyTabs.ts`. `unified` is the identity transform (canonical
  order preserved → genuinely neutral default). This keeps the grouped structure intact
  (avoids Priya's "jarring layout shift") while making the bar visibly lens-aware.

### Orthogonality to `default_landing`
`default_landing` (ADR-0129) decides the surface at `/` (My Work / a project / portfolio).
The lens decides emphasis **within the project shell** once you are in a project. They
operate on different axes and never overwrite each other: a user whose `default_landing`
is `my_work` still gets lens-ordered tabs and a lens-chosen default view when they open
any individual project.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Presentation-only lens: default-view + view-bar emphasis + switcher (chosen)** | Honest against existing surfaces; satisfies the issue AC ("distinct layout", "lands on Schedule/Board"); zero RBAC surface; low collision (one new pure module + localized edits) | "Distinct layout" is emphasis/ordering, not bespoke dashboards — a reviewer expecting full PM/SM dashboards must read the deferral list |
| B. Bespoke PM/SM/Unified dashboards (EVM KPIs, burnup, impediment count per #412) | Maximally "distinct"; matches #412's aspirational copy | The widgets (EVM, gate status, velocity-forecast, impediment log) **do not exist** in OSS today; would balloon to a multi-issue epic and fabricate surfaces — violates "scope to what exists" |
| C. Lens drives `default_landing` / the server landing resolver | One preference instead of two | Conceptually conflates two axes (front-door vs in-project hat); requires a backend resolver change; would overwrite an explicit `default_landing` choice — a future complaint queue |
| D. Switcher only (write + read, no visible effect) | Smallest possible | Fails the issue AC ("each lens renders its distinct layout"); cosmetically pointless — a preference with no consequence |
| E. Lens edits `viewMeta.ts` / `methodologyTabs.ts` to reorder | Fewer files | Mutates the registry consumed by ⌘K palette + ViewsMenu → unintended drift in unrelated consumers; higher merge-collision surface |

## Consequences

**Easier**
- The dual-hat lead opens each project on the surface their current hat cares about, and
  the tab bar leads with their priority views — without changing anyone else's view or
  their own permissions.
- The lens is a pure, additive presentation layer: trivially unit-testable
  (`applyRoleContextLensOrder` is a pure function), and removable without data migration.
- Future lens-driven surfaces (dashboards, alerts) can register against the same
  `role_context` value without re-deciding the invariant.

**Harder / risks**
- **Invariant enforcement is a review responsibility, not a type-system guarantee.** A
  future contributor could be tempted to gate a *write* on `role_context`. The ADR, a
  `frontend/CLAUDE.md` rule, and the security-review gate must hold the line: the lens is
  read in presentation code only; it must never appear in a permission class, a serializer
  `validate_*`, or a write-path guard.
- A PM-lens user on a pure-agile project (where the `schedule` tab is methodology-hidden)
  still lands on `schedule` on project entry. The route resolves and they can navigate
  away; a methodology-aware fallback is a deferred refinement (see Deferred), not a v1
  blocker, because a PM-lens user on a pure-agile project is an unusual combination.
- Two per-user preferences now shape navigation (`default_landing` + `role_context`). The
  settings page must present them as clearly distinct axes to avoid user confusion.

### Explicitly deferred to a follow-up issue
- Bespoke PM / Scrum Master / Unified **dashboards** and per-lens **alert-surfacing**
  widgets (EVM/gate/baseline for PM; impediment count / sprint-scope-at-risk for SM) —
  the underlying widgets do not exist in OSS yet.
- **Sprint-Goal-health callout** in the SM lens (Alex's suggestion).
- **Velocity-based release-forecast** surface in the PM lens (Jordan's suggestion).
- **Mobile lens parity** (Sarah) — web-only in v1; the React Native app reads the same
  `role_context` when native ships (0.4+).
- **Per-team lens context** (Alex) — `role_context` is a single global preference in v1;
  switching teams does not re-prompt. A per-team override is a future enhancement.
- **Methodology-aware default-view fallback** (land on `overview` instead of a
  methodology-hidden preferred view).

## Implementation Notes
- **P3M layer:** Operations / Programs-and-Projects (single-user, single-project-nav).
- **Affected packages:** `web` (switcher, hook, lens module, router redirect, types) +
  `api` (one-field read addition to `MeSerializer` / `get_profile_prefs`).
- **Migration required:** **No** — `role_context` already exists (#412, migration
  `profiles/0004`). No `models.py` change.
- **API changes:** Yes, additive read-only — `role_context` exposed on `GET /auth/me/`
  (self-scoped read of the caller's own preference). The `PATCH /auth/me/profile/` write
  already accepts `role_context` (#412). OpenAPI schema regenerated. `api-docs` synced.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). Verified: `grep -rn
  "trueppm_enterprise" packages/` returns only comments/docstrings, zero live imports.
- **Security/RBAC:** the read is self-scoped (the caller's own profile, like
  `default_landing`/`hidden_views`); no new object-level access. `security-review` +
  `rbac-check` must confirm the lens value never reaches a permission/write gate.

### Durable Execution
1. **Broker-down behaviour:** N/A — no async side effects. The write is a synchronous
   `PATCH` of one column; the read is a synchronous serializer field. No Celery, no
   `.delay()`, no outbox.
2. **Drain task:** N/A — no async work, so no drain.
3. **Orphan window:** N/A — no `transaction.on_commit()` dispatch.
4. **Service layer:** read path goes through the existing
   `profiles/services.py::get_profile_prefs` (extended to a 3-tuple); write path through
   the existing `ProfilePreferencesSerializer.update`. No new service function.
5. **API response on best-effort dispatch:** N/A — the `PATCH` returns the updated
   preference synchronously (200); the read returns `role_context` synchronously on
   `/auth/me/`. No `202 {"queued": true}` path exists.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** the `PATCH` is naturally idempotent (set-a-column to a value;
   re-applying the same value is a no-op). The read is a pure projection.
8. **Dead-letter / failure handling:** N/A — synchronous request/response; a failed
   `PATCH` returns a 4xx/5xx the client surfaces inline and the user retries. No queue,
   no DLQ.
