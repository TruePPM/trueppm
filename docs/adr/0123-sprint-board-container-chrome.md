# ADR-0123: Sprint board — container chrome, scope-injection reach, and the bits already shipped

## Status
Accepted (2026-06-12 — 🔴 resolved: PO+SM facets both accept scope; #1139/#1141 de-scope to the already-shipped surfaces confirmed)

## Context

The board sprint view (#429 / ADR-0119, MR !575) scoped the Kanban to a sprint via a
`?sprint=` URL param. The VoC audit (2026-06-11) found it delivers **a filter, not a
container** — Alex 🔴 ("a board with date columns is not a Sprint"), Priya 🔴 ("see just my
tasks"), Jordan. Four issues followed: #1138 (header + burndown), #1139 (per-column WIP),
#1140 (scope-injection feedback + approve reach), #1141 (my-cards / default / switcher /
read-only).

### What the codebase scan changes about scope (read this first)

Two of the four issues are **substantially already built** — this ADR de-scopes them to
avoid rebuilding shipped surfaces (the recurring "VoC issue describes a near-dup" pattern):

- **#1139 (per-column WIP indicator): ~80% shipped.** `WipBadge` (`BoardView.tsx:234`) +
  `wip.ts::wipState` already render the `3 / 5` / over-limit bands in the column header
  slot. Per-column `wip_limit` is **already persisted** in `BoardColumnConfig.columns`
  (ADR-0039, serializer-level — #1071 is effectively done; only the model docstring is
  stale). **Remaining work:** confirm the count reflects the **sprint-scoped** card set
  when a sprint is selected (not the whole project), and update the stale model
  docstring/help_text to the 5-key shape. No new component, no migration.
- **#1141 (my-cards filter): the filter is shipped.** `useMyTasksFilter` exists, default-ON
  for Members, persisted `trueppm.boardFilter.mine.{userId}.{projectId}`. **Remaining work
  is the other three bullets only:** persist a default sprint, prune the switcher, add a
  closed-sprint read-only indicator.

So the wave's real work is: a board **header bar** (#1138), a **compact burndown wiring**
(#1138), the **scope-injection feedback + facet reach** (#1140), and **default/switcher/
read-only** (#1141 minus my-cards).

### P3M layer
**Programs and Projects** (OSS). Single-project board chrome and project-scoped RBAC.

## Decision

A frontend-heavy wave with **one backend RBAC extension** (#1140) and **no migration**
(every data field already exists: `Sprint.goal/start_date/finish_date`, the WIP config,
the my-cards filter). ADR number **0123** (0122 is the latest on disk; the uncommitted
0120 cross-project work and this wave do not collide).

### 1. Board container chrome (#1138)
- **New `BoardSprintHeader` component**: a bar above the board, shown only when a sprint is
  selected, rendering **Sprint Goal** (`sprint.goal`), **start–finish dates**
  (`start_date`–`finish_date` — note the field is `finish_date`, not `end_date`), and a
  **"Day N of M"** timebox counter. Derive Day-N-of-M client-side from the dates (the
  server already computes it in `MeActiveSprintsView` for reference; no endpoint needed).
- **Compact burndown:** add a `compact` (chrome-less, fixed-small) variant prop to
  `BurnChart` rather than forking it — strip the variant radio / export / date-pickers,
  keep the single burndown line + "N of M points remaining" caption. **Wire it to the
  switcher's `selectedSprint`, not `useActiveSprint`** (today `SprintPanel` binds the
  burndown to the active sprint — viewing a PLANNED/COMPLETED sprint shows the wrong chart).
- **Dedup with #1105** (0.4, ACTIVE-sprint launcher burndown): this board burndown is the
  canonical one; #1105 must consume it, not add a third copy. Cross-referenced, no action
  here beyond not proliferating.

### 2. Per-column WIP (#1139) — verify + de-stale
- Confirm `WipBadge` counts reflect the **sprint-filtered** column set, not the project set,
  when `?sprint=` is active. Fix if it counts the unfiltered set.
- Update the stale `BoardColumnConfig` model docstring/help_text (`models.py:1996-2009`) to
  document the persisted `wip_limit`/`color` keys. No new model, no migration.

### 3. Scope-injection feedback + approve reach (#1140) — the backend touch
- **Drop toast (frontend):** on a successful drag-to-assign into an ACTIVE sprint, fire a
  micro-toast — *"Added to Sprint N as pending scope — awaiting acceptance."* Priya now gets
  in-the-moment feedback; today the drop is silent except for the passive pending chip.
- **Approve reachability (backend RBAC):** today `assert_scope_gate_for_project`
  (`services.py:1705`) is **`role >= Role.ADMIN` + a real `ProjectMembership` row**. Extend
  it so the actor **also passes if they hold the `is_product_owner` OR `is_scrum_master`
  facet** (ADR-0078, `TeamMembership` on a team bound to the project) — the PO is the person
  who *should* accept scope, the SM facilitates. Jordan (PO-as-Member) can then accept from
  the board; today only ADMIN+ can.
  - **The back-door close is preserved (ADR-0102's 🔴):** the gate still requires a real
    project-team membership row with an explicitly-set facet — it remains structurally
    unreachable by any Enterprise/PMO policy resolver. Facets default `False`; no inference.
  - **Frontend:** `useCanManageScope` (today `role >= ADMIN` only) must also honor facets —
    reuse `useMyFacets` (already feeds `useCanManageBacklog`). This ungates the banner Review
    action, the per-card ✓/✗, and the review slide-over for PO/SM-facet holders.
- This is the only part of the wave that needs **rbac-check + security-review** (a
  permission boundary change on a write path).

### 4. Default / switcher / read-only (#1141, minus the shipped my-cards)
- **Smart default sprint:** when no `?sprint=` param is present and the project has exactly
  one ACTIVE sprint, pre-select it; otherwise fall back to Project view. Persist the last
  explicit selection **per-user-per-project in localStorage** (mirror the existing
  `useMyTasksFilter` persistence key pattern). URL param always wins when present
  (shareable links unaffected).
- **Switcher pruning:** group the list as **"Recent (last 3)"** + a **"Show all"**
  disclosure, so a 2-week cadence doesn't grow an unbounded 26+/year list. Pure presenter
  change in `BoardSprintSwitcher`.
- **Closed-sprint read-only indicator:** when a COMPLETED sprint is selected, show a visible
  **"Closed sprint — read only"** banner and give drag a disabled/no-drop visual treatment.
  Today drag into a closed sprint **silently no-ops** the sprint assignment (the status
  move still fires) — confusing per Jordan/Priya. Make the no-op legible.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Rebuild WIP indicator / my-cards from scratch** | clean | rebuilds shipped surfaces (#1139 WipBadge, #1141 useMyTasksFilter); wasted effort, regression risk |
| **Verify + extend only the shipped parts (chosen)** | smallest diff; no regressions | requires the implementer to read existing code first (this ADR points them to it) |
| **Fork BurnChart for the compact board variant** | isolated | two burndown components drift; #1105 dedup intent violated |
| **Add a `compact` variant prop to BurnChart (chosen)** | one source of truth; #1105 can consume it | must not regress the full report variant |
| **Scope-accept honors PO/SM facet (chosen)** | Jordan (PO) can accept scope from the board; matches ADR-0078 role-or-facet pattern already used by `useCanManageBacklog` | widens the write gate — needs rbac-check + security-review; must preserve the ADR-0102 back-door close |
| **Leave scope-accept ADMIN-only** | no authz change | the person who owns scope (PO) still can't accept it — the core #1140 friction |
| **New default-sprint server field** | server-authoritative | over-built; the default is a per-user UI preference — localStorage matches the existing my-cards pattern |

## Consequences

**Easier:** the scoped board reads as a Sprint container (goal, dates, timebox, burndown);
Priya lands on her active sprint with her cards without a click; Jordan can accept scope
he owns; closed sprints stop silently swallowing drops.

**Harder:** the scope-accept gate gains a second authorization axis (role OR facet) — the
gate logic and its tests get more cases, and security-review must confirm the back-door
close still holds. The compact `BurnChart` variant must not regress the full report.

**Risks:**
- *Authz widening (#1140)* — the highest-risk item. Must verify (a) the facet is resolved
  from a real `TeamMembership` bound to the task's project, (b) no PMO/Enterprise resolver
  can synthesize a facet, (c) the frontend gate and server gate agree (server remains the
  boundary; the frontend is render-only). rbac-check + security-review required.
- *WIP count scope* — if `WipBadge` counts the unfiltered project set while the board is
  sprint-scoped, the indicator lies. Must verify against the sprint-filtered `phaseTaskMap`.
- *Burndown sprint binding* — wiring the compact burndown to `selectedSprint` must handle
  PLANNED (no data yet) and COMPLETED (frozen) sprints gracefully (empty/last-snapshot state).

## Implementation Notes
- P3M layer: **Programs and Projects** (OSS)
- Affected packages: **web** (all four issues) + **api** (only #1140's gate extension)
- Migration required: **no** — every field exists (`Sprint.goal/start_date/finish_date`,
  `BoardColumnConfig.columns[].wip_limit`, the my-cards filter).
- API changes: **one permission change** — `assert_scope_gate_for_project` gains a facet
  pass. No new endpoint, no serializer field, no schema change. (Confirm no drf-spectacular
  drift since no enum/field is added.)
- OSS or Enterprise: **OSS**

### Durable Execution
1. **Broker-down behaviour:** N/A — no new async dispatch. The drop toast is client-side;
   the scope-accept path (ADR-0102) is unchanged in its dispatch, only its authz gate widens.
2. **Drain task:** N/A — no new async work.
3. **Orphan window:** N/A.
4. **Service layer:** Reuses `services.py::accept_scope_change` / `reject_scope_change` and
   `assert_scope_gate_for_project` (the only function edited — adds the facet branch). No new
   service.
5. **API response on best-effort dispatch:** N/A — scope accept/reject is synchronous today
   and stays synchronous; this wave does not change response shapes.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** Unchanged — accept/reject idempotency is owned by ADR-0102
   (`SprintScopeChange.status` transition guard). Widening the gate does not alter it.
8. **Dead-letter / failure handling:** N/A — no async work introduced.

## Resolved decisions (2026-06-12)
1. **Scope-accept reach (#1140): PO + SM facets both pass** (alongside `role >= ADMIN`),
   with the ADR-0102 back-door close preserved (real `TeamMembership` + explicit facet, no
   PMO/Enterprise inference). Both Alex (SM) and Jordan (PO) raised #1140.
2. **De-scope (#1139 / #1141): confirmed.** The WIP indicator (`WipBadge` + persisted
   `wip_limit`) and the my-cards filter (`useMyTasksFilter`) are treated as shipped; the
   wave builds only the genuinely-new bits (board header, compact burndown wiring, scope
   toast + facet gate, default sprint, switcher pruning, read-only banner) and verifies the
   existing surfaces against the sprint-scoped card set.
