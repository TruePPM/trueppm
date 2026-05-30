# ADR-0094: Unified Task Activity Timeline — and the History Endpoint Correctness Defects Behind It

## Status
Proposed

## Context

Issue #869 proposes replacing the two task-detail drawer sections (`HistoryTab.tsx` +
`ActivityLog.tsx`) with a single unified `ActivityTimeline` that has an 8-group filter
taxonomy (Dates / Progress / Status / Assignment / Estimates / Description / Comments /
System). The stated motivation is two user-trust problems: (1) the History section renders
bare "Updated 16m ago" pills with **no diff rows**, and (2) the split between two sections
with a useless 3-bucket filter is worse than one timeline with field-group filters.

The issue's proposed implementation rests on three premises:

1. The "bare Updated pill" bug is caused by empty-diff records being stripped at
   `visible = [r for r in page if diffs.get(...)]` in the history app's view, fixable by
   adding `?include_empty=true`.
2. Empty-diff records are CPM auto-bumps that belong in a default-hidden **System** group,
   identifiable by `history_user === null`.
3. The Comments filter group renders zero rows until #307 ships, and comment activity can
   be merged into the timeline at render time from the same history feed.

**Architect research (2026-05-30) found all three premises are factually wrong**, and
surfaced a latent routing defect that makes the proposed backend change edit dead code.
The findings (all cited to current `main`):

**Finding A — the live history view is not the one the issue patches.** `urls.py:110`
includes `projects.urls` *before* `urls.py:114` includes `history.urls`, and both register
the identical pattern `projects/<pk>/tasks/<pk>/history/`. Django matches first-registered,
so the **legacy `TaskHistoryView`** (`projects/views.py:4263`) serves the endpoint and the
newer `TaskHistoryListView` (`history/views.py:149`) — the one containing the `visible`
empty-diff filter the issue wants to toggle — **is dead code for this path**. Adding
`include_empty` there changes nothing the user sees.

**Finding B — CPM auto-bumps create zero history rows.** The scheduler write-back is
`Task.objects.bulk_update(...)` (`scheduling/tasks.py:506`), intentionally bypassing
`save()` to avoid bumping `server_version` (comment at `:451`). `bulk_update` does not fire
`post_save`, which is the only hook django-simple-history uses. No compensating
`HistoricalTask.objects.bulk_create()` exists. **CPM changes never appear in history at
all** — so a "System = CPM auto-bumps" group cannot be populated, and `include_empty`
cannot surface them because they were never recorded.

**Finding C — the real cause of bare pills is a narrow display-diff field set, on USER
edits.** The live legacy view builds its diff from only 11 fields (`_HISTORY_DIFF_FIELDS`,
`projects/views.py:4248`). Any user save that touches a *tracked* field outside those 11 —
`wbs_path` (every drag-reorder / indent / outdent / reparent, the highest-frequency case),
plus `assignee`, `sprint`, `story_points`, `color`, `priority_rank`, `is_subtask`,
`is_recurring` — produces a real DB history row with a **non-empty** underlying change but
an **empty displayed diff**, hence the bare "Updated" pill. These are user actions, not
system actions; default-hiding a "System" group would not fix them and would mis-bin them.

**Finding D — `history_user === null` is not a "system" proxy.** CPM leaves no rows;
the only null-user rows that exist come from non-request-context saves (MS Project import
Celery task, management commands). It is a rare, semantically-different bucket — not "the
CPM noise the PM wants to hide."

**Finding E — `history_change_reason` exists but is never written.** The field is declared
by simple-history and serialized (`history/serializers.py:43`) but no code sets it. There
is currently **no server-side tag** distinguishing automation from user action.

**Finding F — Comments are not on the task audit trail.** `TaskComment` is fully built
(`projects/models.py:2566`, endpoints + `useTaskComments` hook live today — #307 is
effectively already shipped). But comments are a separate model with a separate endpoint;
they produce no `HistoricalTask` rows. Merging them is a **two-feed merge**, not a
render-time tag on the history query. The issue's "#307 not yet shipped" note is stale.

**Finding G — performance.** The live view loads *all* of a task's history into a Python
list and paginates in memory (`history/views.py:166`; legacy view similar). Only a
single-column `history_date` index exists; no composite `(object_id, history_date)`. A
high-churn task degrades every page request.

**Finding H — `planned_finish` does not exist** on `Task` (only `planned_start`,
`projects/models.py:827`). The issue's Dates group lists a non-existent field.

P3M layer: **Programs and Projects** (single-task audit trail). OSS. Boundary grep clean
(zero real `trueppm_enterprise` imports).

## Decision

**Split #869 into a correctness fix and a feature, and correct the feature's premises.**

### Part 1 — Ship the bare-pill correctness fix in 0.2 (new small issue, not #869)

The actual user-trust bug is a backend display defect, independent of any UI redesign.
Fix it directly:

1. **Resolve the URL routing conflict.** Make one view authoritative for
   `tasks/<pk>/history/`. Promote the `history` app's `TaskHistoryListView` (it already has
   pagination config, the broader `_DIFF_EXCLUDED` allow-by-default model, and is where new
   work should live) and retire the legacy `TaskHistoryView`, OR — if retiring is too broad
   for 0.2 — reorder the includes so the history app wins and delete the legacy view in the
   same MR. **Whichever view is made live must compute its diff by allow-list-exclusion
   (everything tracked except `_DIFF_EXCLUDED`), not by an 11-field opt-in**, so `wbs_path`
   and the other tracked fields render a real diff instead of a bare pill.
2. **Keep stripping genuinely-empty diffs** (the `visible` filter is correct *once the diff
   set is wide*): a record whose every changed field is in `_DIFF_EXCLUDED` (e.g. a pure
   `server_version` touch) has nothing to show and should not render a pill. Do **not** add
   `include_empty` — it is the wrong lever; widening the diff field set is the fix.
3. Add the composite index `(object_id, history_date)` on `HistoricalTask` and switch the
   view to slice at the queryset level (`.order_by("-history_date")[offset:offset+size]`)
   instead of materializing all rows (Finding G). This is a small migration + a few lines.

This is a **bugfix with an identified root cause** (fast-path row): `regression-check` →
`test-scaffold` → `changelog` → `/mr`. No new model, no ADR-gated design, low risk. It
makes the *current* History section trustworthy for 0.2's Jun 8 close-out without any
drawer rework.

### Part 2 — The unified ActivityTimeline (#869) moves to 0.3, with corrected design

Reframe #869 against the findings:

- **Drop the "System" group from v1**, or redefine it precisely as *non-request-context
  writes* (imports/management commands) and label it "Automated" — but only if we first add
  the server-side category (below). CPM is not in this bucket and cannot be.
- **Classification is server-side, not client inference.** Add a serialized
  `source: "user" | "import" | "system"` field on the history record, derived at
  serialization time (`history_user` present → `user`; null + known import change_reason →
  `import`; else `system`). To make this meaningful, **start writing
  `history_change_reason`** at the known non-user write sites (the MS Project import task is
  the first concrete one). Client filtering then keys off `source`, not a brittle
  `history_user === null` guess.
- **Comments are a second feed, merged client-side**, from the already-live
  `useTaskComments` hook (Finding F) — not a render-time tag on the history query, and not
  blocked on #307. The Comments chip can be **functional in v1**, not greyed. (If product
  still wants it greyed for scope, that's a product call, not a data limitation.)
- **Filtering stays client-side at 50/page**; the documented 500-record threshold for
  moving the actor filter server-side is retained as a future trigger. The
  extend-`useTaskHistory` / no-new-`/timeline/`-endpoint decision is **kept** — it is sound;
  the timeline is a presentation over the (now-corrected) history feed plus the comment
  feed.
- **Registry move is clean** (ADR-0050): rewrite the section at priority **600** (Activity)
  to render `ActivityTimeline`; delete the priority-900 History registration. Registration
  is idempotent by `id`; deleting one `register()` call and rewriting another is within the
  contract. No registry-core change.
- Fix `FIELD_TO_GROUP`: drop `planned_finish` (Finding H); confirm every mapped field name
  against `projects/models.py` before coding (`actual_start`/`actual_finish` exist;
  `planned_finish` does not).

### Part 3 — OpenAPI / enum risk

The new `source` enum (`user|import|system`) **will** collide with drf-spectacular's
component-name generation if any other serializer ships a same-named enum — this is the
known `SourceEnum` footgun. Pin it in `ENUM_NAME_OVERRIDES` (e.g. `ActivitySourceEnum`)
**in the same commit** that adds the field, and regenerate `docs/api/openapi.json` after
merging `origin/main` (per CLAUDE.md OpenAPI discipline). Part 1 adds no new enum or param,
so it carries no schema-drift risk — another reason it is a safe 0.2 landing.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A — Split: Part 1 bugfix in 0.2, full timeline in 0.3 (chosen)** | Ships the real user-trust fix now, low-risk, no schema churn; gives 0.3 a correct foundation | #869 slips a milestone; two issues instead of one |
| B — Build #869 as written in 0.2 | Single issue closed | Patches dead code (Finding A), builds an unpopulatable System group (B/D), greys a working feature (F), maps a non-existent field (H); the bare-pill bug would *remain* because the fix is in the wrong view. Ships a feature that doesn't fix its stated bug. |
| C — Minimal fallback (chips on ActivityLog, no backend) in 0.2 | No backend work | Sits on top of the same buggy display-diff; the bare pills persist; the System chip is dead. Cosmetic only — doesn't earn the user-trust win. |
| D — Whole thing to 0.3, fix nothing in 0.2 | Clean close-out | Leaves a known, field-confirmed trust bug (bare pills on every reorder) shipping in 0.2. Cheap to fix now; not fixing it is the worse trade. |

Option A dominates: it decouples the cheap, high-value correctness fix from the
premise-corrected feature, and prevents 0.2 from shipping a redesign built on a routing bug.

## Consequences

- **Easier:** 0.2 ships a *trustworthy* history section (every reorder/assign/sprint change
  shows a real diff). 0.3 builds the timeline on a single authoritative endpoint with a real
  server-side `source` classification instead of a brittle null-user guess.
- **Harder:** Resolving the URL routing conflict means consciously retiring `TaskHistoryView`
  — grep for any other caller/test asserting against its exact payload shape before deleting
  (it exposes `history_user` ungated; confirm no rbac test depends on the legacy shape).
- **Risks:**
  - Retiring the legacy view may shift the JSON contract (field set widens). The web
    `useTaskHistory` consumer and `HistoryTab.tsx` must be checked against the new diff set
    in the same MR (regression-check). E2E `task-drawer-*.spec.ts` may assert on the old
    bare-pill behavior — grep `packages/web/e2e/` before merging Part 1.
  - Writing `history_change_reason` at import sites is a new convention; document it so
    future non-user write paths follow it (otherwise `source` silently mis-classifies).
  - The composite index migration touches a high-row-count historical table — review for
    lock duration (`CREATE INDEX CONCURRENTLY` via a non-atomic migration if the table is
    large in any real deployment).

## Implementation Notes
- P3M layer: Programs and Projects (single-task audit). OSS.
- Affected packages: **api** (Part 1: history/projects views, urls, migration; Part 2:
  serializer `source` field, import change_reason), **web** (Part 2: ActivityTimeline,
  filter groups, section registry).
- Migration required: **yes** — composite `(object_id, history_date)` index on
  `HistoricalTask` (Part 1). No schema change to the live model.
- API changes: Part 1 — diff field set widens (contract change, no new param/enum). Part 2 —
  new serialized `source` enum (pin in `ENUM_NAME_OVERRIDES`).
- OSS or Enterprise: **OSS** (trueppm-suite). Boundary grep clean.

### Durable Execution
1. **Broker-down behaviour:** N/A — history read endpoint and the diff fix are synchronous
   reads/serialization; no async dispatch. The only write touched (Part 1 index migration)
   is schema, not runtime work. Part 2's `history_change_reason` is written inline at the
   existing import task's save point, inside that task's own transaction — it adds no new
   dispatch.
2. **Drain task:** N/A — no new async category.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** N/A — no CPM/schedule dispatch on this path. (Note: CPM's *existing*
   `enqueue_recalculate()` is unaffected; this ADR deliberately does **not** make CPM write
   history rows — that would be a separate, larger decision.)
5. **API response on best-effort dispatch:** N/A — synchronous GET; returns paginated
   records directly.
6. **Outbox cleanup:** N/A. (Existing 90-day history purge per ADR-0011 still applies and is
   unchanged.)
7. **Idempotency:** N/A for the read path. Writing `history_change_reason` is idempotent —
   it sets a constant string on the row created by the import's own `save()`; re-running the
   import creates new rows with the same reason, no duplicate-detection needed.
8. **Dead-letter / failure handling:** N/A — no new task. A serialization error on `source`
   falls back to `"user"`/`"system"` by the documented derivation; it cannot fail the
   request.
