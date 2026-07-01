# ADR-0196: Methodology-aware mobile BottomNav with a "More" overflow sheet

## Status
Proposed

## Context
The mobile bottom navigation rail (`packages/web/src/features/shell/BottomNav.tsx`,
shown `< md`) hardcodes nine items — `overview, today, board, sprints, schedule,
grid, calendar, resources (Team), settings` — and renders every methodology-visible
one as an equal `flex-1` cell in a fixed `h-14` rail. It omits **`product-backlog`,
`risk`, and `reports` entirely for every methodology**, and it has no overflow
mechanism, so it cannot grow to cover them without cramming.

Issue #1464 is the **highest-consensus finding** of the methodology-view-bar VoC
audit — raised by all five hybrid-panel personas, a borderline hard-NO from Jordan
(Product Owner) and a near-hard-NO from Marcus (PMO):

- **Jordan (PO)** cannot reach the **Backlog** — his most-touched surface — on the
  phone, where roughly half his grooming happens.
- **Marcus (PMO)** cannot pull the **Risk register** or **Reports** on a phone in an
  exec meeting.
- **Alex (Scrum Master)** cannot touch the **Backlog** on mobile before Sprint
  Planning.
- **Sarah (PM)** finds nine equal-weight `flex-1` cells too dense to tap accurately
  on a job site (gloves, glare).

This is the same bug class as #1324 (Today was missing from the rail — fixed) and
#539 (Settings added to the rail). The rail also does **not** honor the per-user
`hidden_views` preference (ADR-0139 §4 explicitly deferred mobile), and applies no
per-project surface-visibility gate (ADR-0193) — so a `reports`-off project would,
once `reports` is added, still show the tab on mobile.

**P3M layer:** Programs and Projects (single-project chrome). **OSS** — this is core
navigation for one PM/team; nothing here aggregates across projects.

### Constraints in play
- **Mobile-first**: touch targets ≥ 44px; works offline; no new network dependency.
- **API-first / no new server surface**: everything needed already ships on existing
  payloads — `effective_methodology`, `effective_surface_visibility`,
  `effective_iteration_label`/`iteration_label` on `useProject`, and `hidden_views`
  on `useCurrentUser` (`GET /auth/me/`). Confirmed: **no API change**.
- **Routes unchanged** (rule 108 / ADR-0030): the rail changes which views are
  *surfaced* and *where*, never a route segment.
- **Must not regress #1324** (Today reachable on mobile) or **#539** (Settings
  reachable on mobile).
- **ADR-0134 rule 3**: on mobile the view strip is replaced by `BottomNav` (never
  both the desktop overflow scroller and the rail). Mobile's answer to overflow is a
  *different component*, not the desktop `overflow-x` scroller — so this ADR defines
  that component (a "More" sheet), it does not reuse ADR-0134's scroller.

## Decision

Rebuild `BottomNav` as a **≤5-slot, methodology-aware rail with a "More" overflow
bottom sheet**. Three decisions:

### 1. The set of reachable views is shared with desktop; the mobile *order* is mobile-specific

The **set** of views a user can reach on mobile is exactly the set the desktop view
bar computes — the single source of truth — composed through the existing pure
helpers in `methodologyTabs.ts`:

```
reachable = methodology filter (isTabVisibleForMethodology / effective_methodology)
          ∩ per-project surface visibility (surfaceHiddenViews ← effective_surface_visibility.reporting)
          ∩ per-user hidden set (hidden_views, ADR-0139 — now applied on mobile)
          ∩ role gate (resources requires role ≥ ROLE_SCHEDULER)
   ∪ { overview }   // always-on landing (never hideable) — nav can't be emptied
   ∪ { settings }   // always reachable (admin), member-visible; writes gated in-page
```

The **order** is *not* inherited from the desktop group order (PLAN·SPRINT·TRACK·
PEOPLE). Desktop group order front-loads PLAN, which would bury Today deep in the
rail and regress #1324. Mobile is a distinct form factor (ADR-0134 rule 3 — a
distinct component), so it gets a **mobile-specific primary-priority order** optimized
for thumb reach and daily frequency. This keeps the reachable *set* coherent with
desktop while letting the rail lead with the views a phone user actually taps.

### 2. ≤5 slots: a static per-methodology primary-priority list, backfilled, with "More" as the last slot

The rail has **exactly five slots**. A static, per-methodology **primary-priority
list** names the preferred primary views in order. The algorithm:

1. `primary` = first up-to-**4** views from `MOBILE_PRIMARY_PRIORITY[methodology]`
   that are in `reachable`. If fewer than 4 are available (restricted project /
   personal hides), backfill from the remaining `reachable` views in canonical order
   so the rail stays dense.
2. `overflow` = `reachable` − `primary`, in canonical order (Settings always sorts
   last here).
3. If `overflow` is non-empty → render the 4 primary tabs + a **More** button in slot
   5. If everything fits (`reachable` ≤ 5) → render all as tabs, no More button.

`overview` is always the head of every priority list, so it is always primary;
`today` is always second (the #1324 guarantee). The per-methodology tables:

| Methodology | Primary rail (in order) | More sheet (canonical order) |
|-------------|-------------------------|------------------------------|
| **WATERFALL** | Overview · Today · Schedule · Grid · **More** | Board · Calendar · Team† · Risks · Reports‡ · Settings |
| **AGILE** | Overview · Today · Board · Backlog · **More** | Sprints · Grid · Team† · Risks · Reports‡ · Settings |
| **HYBRID** | Overview · Today · Board · Backlog · **More** | Sprints · Schedule · Grid · Calendar · Team† · Risks · Reports‡ · Settings |

† Team (`resources`) appears only when the caller's role ≥ Scheduler.
‡ Reports appears only when `effective_surface_visibility.reporting` is true.

Rationale for the primary picks:
- **AGILE/HYBRID lead with Board + Backlog** — the sprint circuit's daily-touch pair.
  This is the direct fix for Jordan/Alex (Backlog now primary) and keeps mobile
  coherent with the desktop SPRINT-group intent (ADR-0195, sibling MR !893): Board and
  Backlog are the two the team touches every day.
- **WATERFALL leads with Schedule + Grid** — the schedule-first daily pair (Sarah).
- **Risks and Reports land in More on every methodology** — infrequent on a phone but
  now **reachable** (Marcus's blocker was *unreachable*, not *not-primary*; acceptance
  #2 is satisfied by overflow).
- **Sprints in More** (not primary): planning cadence, not a daily thumb-tap.
- **Settings always in More** (it was previously a pinned trailing tab). It stays
  reachable — #539 is satisfied by overflow reachability — and the More button
  reflects an **active** state when the current view is any overflow member, so
  "Settings stays active on the settings page" still holds at the rail level.

A static table (not a lens-derived primary set) is the **simplest coherent rule** for
0.4: predictable, testable, and it already resolves the five-persona conflict via
methodology (each methodology's daily pair is primary). The role-context lens
(ADR-0162, promote a role's priority views) is explicitly **deferred** — its mobile
parity is already deferred by ADR-0162 itself, and layering it onto the primary
selection is a 0.5+ refinement, not a 0.4 requirement.

### 3. The "More" overflow is the existing `BottomSheet`; ADR-0139 `hidden_views` now applies to the rail

- **More sheet**: reuse `packages/web/src/components/ui/BottomSheet.tsx` — it already
  owns the scrim, slide-up transition, **focus trap**, **Escape-to-close**,
  `role="dialog"` + `aria-modal="true"`, and `mobileOnly` gating. The sheet lists the
  overflow views as full-width ≥44px `NavLink` rows (icon + label from the shared
  `VIEW_TAB_META`), and closes on navigation. The trigger is a rail `<button>`
  (`MoreHorizontalIcon` + "More"). **Known limitation:** `BottomSheet` does not lock
  body scroll; acceptable for a short (≤8-row) menu, noted for follow-up if it grows.
- **ADR-0139 extension to mobile (acceptance #5)**: the rail now reads
  `useCurrentUser().hidden_views` and applies the **same global per-user hidden set**
  to `reachable` (via `groupedVisibleViewsForUser` / the shared hide-union). Hiding a
  view on desktop hides it on mobile — one preference, both surfaces. This lifts the
  ADR-0139 §4 "BottomNav does NOT apply the personal set" carve-out. **No new API /
  model / preference** — `hidden_views` already exists and is written by
  `useUpdateHiddenViews` (`PATCH /auth/me/profile/`).
  - **Reorder** is *not* delivered on mobile in 0.4: ADR-0139 stores a hidden **set**
    with **no order** (drag-to-reorder was itself deferred to 0.7). There is no order
    to extend. When 0.7 adds a persisted order, the mobile rail can consume the same
    preference. Mobile primary *order* in 0.4 is the static `MOBILE_PRIMARY_PRIORITY`.
    "Extend ADR-0139" therefore means "extend what ADR-0139 actually provides" = the
    hide set.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. ≤5 static-per-methodology primary + `BottomSheet` More, shared reachable set (chosen)** | Predictable, testable; reuses BottomSheet a11y; resolves persona conflict via methodology; no API change; keeps desktop as SoT for the *set* | Static primary set can't reflect an individual's role priority (deferred to lens, 0.5+) |
| **B. Flatten the desktop grouped/lensed order and take a prefix** | One ordering source, zero mobile-specific table; auto-coherent with ADR-0195 | Desktop group order front-loads PLAN → **buries Today** (regresses #1324); depends on unmerged ADR-0195; lens flatten adds complexity |
| **C. Horizontal-scroll rail (reuse ADR-0134 scroller on mobile)** | No overflow sheet to build | Violates ADR-0134 rule 3 (mobile ≠ desktop scroller); off-screen tabs are undiscoverable; poor for gloves/glare (Sarah) |
| **D. Add all tabs as `flex-1`, drop none** | Trivial | Cells fall below 44px thumb targets at ≥8 items — the exact density complaint; fails mobile-first |
| **E. New per-user *mobile* preference for the primary set** | Fully user-tunable | New model + API + migration; ADR-0139 deliberately kept the preference **global** (per-project map was VoC-rejected as a "configuration tax"); over-scoped for 0.4 |

## Consequences

**Easier**
- Backlog, Risks, and Reports are reachable on mobile for the methodologies that show
  them (acceptance #1, #2).
- The rail respects the same `hidden_views` a user set on desktop (acceptance #5,
  hide) and the per-project `reporting` toggle (ADR-0193) — one consistent visible set
  across surfaces.
- Touch targets stay ≥44px (≤5 slots), fixing the density complaint (Sarah).

**Harder / risks**
- One more place that must stay in sync with the shared view vocabulary. Mitigated by
  composing the *set* through the same `methodologyTabs.ts` helpers and drawing
  labels/icons from the same `VIEW_TAB_META` — only the mobile *order* table is new.
- The static primary table encodes a product judgment about "daily" views; if it's
  wrong for a segment, the answer is the deferred lens (0.5+), not per-user mobile
  config.
- Settings moving from a pinned tab into More is a visible change; the e2e spec that
  asserts a direct Settings tab is updated in the same commit (#539 intent preserved
  via overflow reachability + active-state reflection on More).
- Depends conceptually on ADR-0195 (sibling MR !893) for desktop coherence but **not
  in code** — this branch touches `BottomNav.tsx` + a new mobile helper, not the
  methodologyTabs group definitions. Rebase onto main after !893 merges; no code
  conflict expected.

## Implementation Notes
- **P3M layer**: Programs and Projects (single-project chrome).
- **Affected packages**: `web` only.
- **Migration required**: no.
- **API changes**: **none** — reuses `effective_methodology`,
  `effective_surface_visibility`, `iteration_label`/`effective_iteration_label`
  (`useProject`), and `hidden_views` (`useCurrentUser`).
- **OSS or Enterprise**: OSS.
- **Files**:
  - `packages/web/src/features/shell/BottomNav.tsx` — rebuilt: compose reachable set,
    split primary/overflow, render rail + More trigger.
  - `packages/web/src/features/shell/bottomNavItems.ts` (new) — `MOBILE_PRIMARY_PRIORITY`
    per methodology + the pure `selectMobileNav(reachable, methodology)` splitter
    (unit-testable, no React). Kept **out of** `methodologyTabs.ts` to avoid conflict
    with the in-flight ADR-0195 edits there.
  - `packages/web/src/features/shell/MoreSheet.tsx` (new) — thin wrapper over
    `BottomSheet` listing overflow views as `NavLink` rows.
  - Reuse `VIEW_TAB_META` (labels/icons), `MoreHorizontalIcon`, `iterationLabelForms`.
- **Reachability**: the rail *is* the mobile entry point; every primary and overflow
  item is a real `NavLink`, no route-only surfaces.
- **Design-system-v2**: semantic tokens only (reuse the existing rail token classes);
  no raw hex; comments use "issue NNNN", not `#NNNN` (DS-v2 hex-ratchet gate).

### Durable Execution
This feature is pure client-side navigation chrome — no server mutation, no async
work, no Celery task, no broker interaction. Every question below is N/A.

1. **Broker-down behaviour**: N/A — no dispatch; the rail only reads already-cached
   `['project', id]` and `['current-user']` queries. Hiding a view (the one write
   path touched, ADR-0139) already goes through the existing `useUpdateHiddenViews`
   mutation, unchanged by this ADR.
2. **Drain task**: N/A — no async work introduced.
3. **Orphan window**: N/A — no outbox rows.
4. **Service layer**: N/A — no backend call added; the reused `PATCH /auth/me/profile/`
   is unchanged.
5. **API response on best-effort dispatch**: N/A — no new endpoint.
6. **Outbox cleanup**: N/A — no outbox rows.
7. **Idempotency**: N/A for new work; the reused `hidden_views` PATCH is already
   idempotent (sends the full desired set, not a delta).
8. **Dead-letter / failure handling**: N/A — no task. If the `hidden_views` PATCH
   fails, the existing optimistic-toggle-then-revert behavior applies (unchanged).
