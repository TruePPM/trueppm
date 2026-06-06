# ADR-0108: Rollup Engine — parent percent-complete, schedule dates, and scope delta

## Status
Proposed

## Context

Issue #408 asks for a "rollup engine" so a parent/summary `Task` reflects its children: a
real `percent_complete` even when the children are scrum stories, rolled-up schedule dates,
and a scope delta against the active baseline. The work item must read correctly whether a
subtree is delivered waterfall, scrum, or kanban (`Task.delivery_mode`, shipped in #407 /
ADR-0036).

**P3M layer**: Programs and Projects / Operations — single-project, single-team WBS
computation. Fully **OSS**. No cross-program aggregation (that is the Enterprise program/
portfolio rollup, ADR-0079/0088, which *consumes* this). `grep -r trueppm_enterprise
packages/` is clean and stays clean.

### What already exists (verified on main, 2026-06-06)

The issue's premise — "parent `percent_complete` is edited directly and has no relationship
to its children" — is **stale**. The codebase already rolls up percent-complete, and two
accepted/established ADRs already fix the architecture:

1. **ADR-0024 (Summary Tasks and WBS Rollup)** is the governing design. It mandates:
   - `is_summary` / `parent_id` are **query annotations, never stored columns** ("storing them
     creates staleness and requires triggers or signals").
   - `percent_complete` rolls up as a **serializer annotation** (always fresh, duration-weighted
     average of children) — *not* a stored field, *not* in the scheduler engine.
   - Date / float / critical rollup (`early_start=MIN(children)`, `early_finish=MAX(children)`,
     `is_critical=any child`, `total_float=MIN(children)`) happens in a **post-CPM step** (the
     schedule recompute Celery task), because those only change when CPM runs.
   - Summary tasks are **excluded from the CPM forward/backward pass**.
   - ADR-0024 explicitly names #408 as the issue that implements its still-open rollup scope.

2. **ADR-0074 (Sprint→Milestone Rollup)** already implements the same computed-on-read
   pattern for milestones and **explicitly rejected storing rollup fields on `Task`**:
   *"New migration on the hottest table; every sprint mutation must thread the rollup write
   through `update_fields`; stale-state risk across 6+ write paths; ADR-0024 already
   establishes that summary rollups compute on serialize."* It also already makes a
   sprint-linked task's `percent_complete` **read-only** via
   `TaskSerializer.validate_percent_complete()`.

3. **The current percent annotation** (`TaskViewSet.get_queryset.percent_complete_rollup`)
   is duration-weighted over **leaf descendants** (ltree `.*{1,}` + double `NOT EXISTS` to
   pick leaves), serializer-applied in `TaskSerializer.to_representation`. It is **not**
   delivery-mode aware — every leaf contributes its raw `percent_complete` weighted by
   `duration`.

### The gaps #408 must actually close

- **percent-complete is not delivery-mode aware** — a scrum leaf should contribute story-point
  burndown, a kanban leaf item-done state, a milestone leaf gate state.
- **No schedule-date rollup** — there is no summary `early_start=MIN / early_finish=MAX`
  post-CPM step and no `planned_finish` column at all.
- **No scope delta** — and `BaselineTask` stores only dates + `duration`, **no story_points /
  scope**, so there is no baseline scope to diff against.
- **summary `percent_complete` is writable-but-ignored** — the stored field is silently
  overridden on read; it should be rejected on write (consistency with ADR-0074's milestone
  guard).

### Forces

- **API-first**: the rollup is read on every task list/detail; it must stay a single
  annotated query, no N+1.
- **No stale state** (ADR-0024/0074): the hot `Task` table must not gain rollup columns that
  6+ write paths have to keep consistent.
- **CPM bypasses `Task.save()`**: schedule recompute writes via `bulk_update` (intentional, to
  avoid `server_version` churn), so a `post_save` rollup signal would **not** fire on a CPM
  run. Date rollup must live in the post-CPM step, not a save signal.
- **Sprint sovereignty / velocity privacy** (ADR-0036/0102/0106): the rollup may surface an
  aggregate milestone/phase percent upward, never a raw per-team velocity series.
- **The scheduler package has zero Django deps**: rollup is an ORM concern, never in
  `trueppm-scheduler`.

## Decision

**Adopt Option A — computed-on-read, extending the established ADR-0024/0074 pattern.** Do
**not** introduce stored rollup fields, a `post_save` ancestor-walk signal, or a "repair task"
(the #408 issue text predates the computed-on-read annotation; those AC items are superseded —
a computed value is always fresh, so there is nothing to repair and no signal to fire).

Three pieces:

### §1 — Delivery-mode-aware percent-complete (serializer annotation, extends the existing one)

Replace the duration-only `percent_complete_rollup` SQL with a delivery-mode-aware
weighted average over **leaf descendants**. Each leaf contributes a `(weight, percent)` pair
derived from **its own** `delivery_mode`:

| Leaf `delivery_mode` | contributed `percent` | `weight` |
|---|---|---|
| `waterfall` (default) | `percent_complete` (explicit) | `duration` (working days) |
| `scrum` | story-point burndown: `100` if `status=COMPLETE`, else `(1 − COALESCE(remaining_points, story_points) / NULLIF(story_points,0)) × 100`, falling back to `percent_complete` when `story_points` is null | `COALESCE(story_points, duration)` |
| `kanban` | item state: `100` if `status=COMPLETE` else `0` | `1` (each item counts once → parent % = done/total) |
| `milestone` | gate: `100` if `status=COMPLETE` else `0`, **only if it has no children**; excluded when it is a pure schedule gate with `duration=0` and no work | `0` (excluded from the weighted sum so a zero-work gate never dilutes the phase percent) |

`percent = round(Σ(weight × percent) / NULLIF(Σ(weight), 0), 2)`, `NULL` when total weight is 0
(leaf-only / no-children case → the serializer leaves the stored value untouched, exactly as
today). Mixed-mode subtrees sum weights in each leaf's native unit; this is a deliberate,
documented approximation (story-points and duration-days are not the same unit, but within a
phase the dominant mode's weight carries the average — see Alternatives for why per-mode
normalization was rejected as over-engineering for 0.3). Recurring tasks (`is_recurring=True`,
`wbs_path IS NULL`) and `BACKLOG`/`EPIC` rows are excluded, consistent with `CommittedTaskManager`
and ADR-0090/0101.

This stays a **single RawSQL annotation** on `TaskViewSet.get_queryset` (the `CASE` lives in
the existing leaf subquery), applied in `to_representation` — no new query, no N+1.

### §2 — Schedule-date rollup (post-CPM step, per ADR-0024)

In the schedule recompute task (`apps/scheduling/tasks.py`, after the CPM `bulk_update` of leaf
dates), add a summary-date rollup pass that sets, for every summary task (a task with WBS
children), `early_start = MIN(leaf-descendant early_start)` and `early_finish = MAX(leaf-descendant
early_finish)`, written via the same `bulk_update` (so it inherits the no-`server_version`-churn
behavior and the existing broadcast). This is the canonical ADR-0024 split: **dates roll up only
when CPM runs**, percent rolls up on every read. We do **not** add a `planned_finish` column;
`early_finish` is the rolled-up summary finish (the issue's "planned_finish = max(child)" maps to
`early_finish` on the CPM spine, the field the Gantt already renders).

### §3 — Scope rollup + delta (annotation; requires one additive baseline field)

`current_scope` = `SUM(leaf story_points)` over committed leaf descendants (a serializer/endpoint
annotation, same leaf subquery shape). `scope_delta = current_scope − baselined_scope`. Because
`BaselineTask` stores no scope today, add one additive nullable field **`BaselineTask.story_points`**
(`PositiveSmallIntegerField(null=True)`) captured at baseline-snapshot time (the only model/migration
change in this ADR; `BaselineTask` is immutable-after-create and not on the sync surface, so this is
a low-risk append). `baselined_scope` = `SUM(BaselineTask.story_points)` over the active baseline's
rows for the subtree's leaves. When no active baseline exists, `scope_delta = null` (not zero) — the
UI shows "no baseline" rather than a misleading 0. Scope is surfaced as a computed block on the task
detail / a dedicated `?include=scope` annotation, not stored on `Task`.

### §4 — Read-only summary percent (serializer guard)

Extend the existing `TaskSerializer.validate_percent_complete()` (already rejects writes on
sprint-linked milestones, ADR-0074) to also reject a write when the task **has WBS children**
(is a summary). Leaf tasks stay writable. This makes the silent override explicit and prevents a
PM from "setting" a phase percent that the next read discards. Implemented with the same
`EXISTS(direct child)` check used for `is_summary`.

### §5 — EVM scaffolding (deferred, not in this ADR's MR)

The issue mentions parent `planned_value` / `earned_value` "scaffolding." Full EVM is Enterprise.
The OSS scaffold (PV/EV computable from children without `actual_cost`) is **out of scope for the
first #408 MR** and tracked as a follow-up — it is a pure additive annotation that can layer on §1
later without rework. Flagged here so it is not silently dropped.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: computed-on-read, extend the ADR-0024/0074 annotation (chosen)** | Always fresh; no stale state; no hot-table migration for percent; no signal storm; immune to the CPM-`bulk_update`-bypass problem; consistent with two existing ADRs; single annotated query | Slightly heavier read SQL (a `CASE` per leaf); mixed-unit weighting is an approximation; date rollup must ride the CPM task (acceptable — that is where dates change) |
| B: stored rollup fields + `post_save` ancestor-walk signal + Celery repair task (the literal #408 AC) | Matches the issue text; O(1) read | **Explicitly rejected by ADR-0074**: migration on the hottest table; 6+ write paths must thread `update_fields`; staleness needs a repair task; `post_save` never fires for CPM `bulk_update`, so dates would silently rot; signal storm on bulk edits. Rejected. |
| C: hybrid (percent computed, dates+scope stored) | — | Worst of both: still needs the repair task and signal for the stored half, while splitting the mental model. Rejected. |
| D: per-mode normalized weighting (convert story-points↔duration to a common unit before averaging) | Dimensionally pure mixed-mode percent | Needs a points→days conversion factor (velocity), which is team-private and sprint-scoped; couples the read path to velocity; far more complexity than the 0.3 demo needs. Deferred — §1's native-unit weighting is good enough and documented. |

## Consequences

**Easier**: a phase shows a real percent even when its children are scrum stories (the hybrid
promise, ADR-0036); summary dates and scope delta render from one query; nothing can write a
stale parent percent; the Enterprise program/portfolio rollup keeps consuming a single
computed value.

**Harder**: the read SQL gains a `delivery_mode` `CASE`; the schedule task gains a summary-date
pass; one additive `BaselineTask.story_points` field + migration; mixed-mode weighting is an
approximation the UI/docs must not over-claim.

**Risks**: (1) read-SQL cost on huge WBS trees — mitigated by the existing leaf subquery already
being the read path (we change the projection, not the shape) + the ltree GiST index. (2)
mixed-unit weighting confusing a PM — mitigated by surfacing `rollup_basis` so the UI can label
it. (3) baselines created before this change have `story_points=null` → `scope_delta=null` for
them (honest: no baseline scope captured) — acceptable, documented.

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations (single project). **OSS.**
- **Affected packages**: api (rollup SQL in `views.py`, schedule-date pass in `scheduling/tasks.py`,
  `validate_percent_complete` guard + scope annotation in `serializers.py`, one `BaselineTask`
  field + migration), web (consume delivery-mode-aware percent + scope delta — separate FE issue).
  scheduler: **no change** (zero Django deps preserved). Mobile: rollup is read-side; no sync field.
- **Migration required**: **yes, one additive field** — `BaselineTask.story_points` (nullable). No
  fields on `Task` (the whole point). `BaselineTask` is a plain model (no HistoricalRecords) and
  immutable-after-create.
- **API changes**: `percent_complete` rollup becomes delivery-mode aware (same field, better value);
  new computed `scope` block (`current_scope`, `baselined_scope`, `scope_delta`, `rollup_basis`);
  `percent_complete` now rejected (400) on a summary task write. Regenerate OpenAPI after merging
  main.
- **OSS or Enterprise**: **OSS**. Enterprise program/portfolio rollup (ADR-0079/0088) consumes it.
- **Coordinate with**: ADR-0024 (this implements its open scope), ADR-0074 (reuse the milestone
  rollup + read-only pattern), ADR-0106 (`compute_milestone_rollup_payload` already owns
  milestone percent — §1 governs WBS-summary percent; a milestone that is also a summary keeps the
  ADR-0074 sprint rollup winning, as `to_representation` already orders it).
- **Testing** (three-layer): pytest — single-child, multi-child, mixed-delivery-mode parent
  (waterfall+scrum+kanban leaves), no-children edge, scope_delta with/without active baseline,
  summary-percent write rejected (400), leaf-percent write still allowed, date rollup MIN/MAX after
  a CPM run. vitest/web — separate FE issue. Playwright — phase shows rolled-up % over scrum
  children (FE issue).

### Durable Execution
1. **Broker-down behaviour**: N/A for §1/§3 (pure read annotations, no async). §2 rides the
   existing schedule-recompute task, which already goes through `enqueue_recalculate()` (the
   ScheduleRequest outbox); no new dispatch path, so no new durability gap.
2. **Drain task**: none new — §2 is a step inside the existing CPM recompute task; §1/§3 are
   synchronous reads.
3. **Orphan window**: N/A — no new outbox rows.
4. **Service layer**: §2 extends the existing schedule recompute (reached via
   `scheduling/services.py::enqueue_recalculate`); a new pure function
   `services.py::compute_scope_rollup(task)` for §3, mirroring `compute_milestone_rollup_payload`.
   No bare `.delay()`.
5. **API response**: synchronous reads (200) for §1/§3; §2 has no API response (internal CPM step).
6. **Outbox cleanup**: N/A (no new outbox).
7. **Idempotency**: rollups are pure functions of current state — every read/recompute yields the
   truth; the §2 `bulk_update` is idempotent (writes MIN/MAX deterministically).
8. **Dead-letter / failure**: §2 failure falls to the existing ScheduleRequest retry/drain; a
   §1/§3 read error surfaces as a normal 5xx — no stored state to corrupt. The reason a "repair
   task" (issue AC) is unnecessary: with no stored rollup state there is nothing to repair.

## Phased implementation plan
1. **Phase 1 (this MR)** — §1 delivery-mode-aware percent annotation + §4 read-only summary guard
   + pytest (single/multi/mixed/no-children + write-rejection). Highest value, no migration.
2. **Phase 2** — §2 schedule-date rollup in the CPM post-step + pytest (MIN/MAX after recompute).
3. **Phase 3** — §3 scope rollup + `BaselineTask.story_points` migration + pytest (delta
   with/without baseline).
4. **Phase 4 (follow-up issue)** — §5 EVM PV/EV scaffold.

Phases 1–3 can land as one MR or three; Phase 4 is a separate issue. The web consumption
(delivery-mode-aware % chip, scope-delta drawer) is a separate frontend issue.
