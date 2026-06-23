# ADR-0168: Sprint-window schedule floor for agile tasks

## Status
Accepted

<!-- ADR numbers 0165–0167 are claimed by in-flight MRs not yet on main
(0165: !758/!759, 0166: !761, 0167: !759 after a renumber); 0168 is the next free slot. -->

## Context
TruePPM is scheduling-first: the CPM schedule is the spine, and sprints are an
agile overlay on top of it. But the two layers do not meet where it matters most
for a hybrid project — the timeline.

A task is positioned on the schedule (Gantt) only by its CPM-computed
`early_start`/`early_finish`, or, for completed/in-progress work, by its pinned
actuals (ADR-0132). **Sprint membership never feeds CPM.** The single
CPM↔Monte-Carlo input converter, `build_sched_tasks`
(`scheduling/services.py:381`), maps `duration`, `planned_start`, the progress
fields, and PERT — but never reads `Task.sprint`.

A sprint-planned "story" is typically created with no `planned_start` (the team
commits it to a *sprint*, not to a calendar date) and a small default duration.
In the progress-aware forward pass (`packages/scheduler/.../engine.py:680-767`)
such an unconstrained task floors its `early_start` at the **project start date**.
The result, visible in the Helios hybrid demo: only *completed* stories — which
the demo replay pins to `actual_start`/`actual_finish` inside their sprint window —
render in the right place; every IN_PROGRESS and BACKLOG story collapses to a
1-day bar at the project origin, months before its sprint. The one story carrying
a dependency lands mid-schedule via that dependency, which proves the mechanism:
absent any constraint, sprint work has nowhere to go but the origin.

This is the seam between the agile overlay and the CPM spine. The board view
positions a story by its sprint; the schedule view cannot, so the story falls to
the origin. The same gap affects any real hybrid project, not just the demo.

**P3M layer:** Programs and Projects (single-project schedule + its agile
overlay). OSS — sprints, hybrid scheduling, and CPM are all community-edition.

## Decision
Give a sprint-assigned task a **synthetic SNET floor at its sprint's
`start_date`** when building the CPM/Monte-Carlo input, so it positions inside its
sprint window instead of at the project origin.

The floor is applied in the **single shared converter** `build_sched_tasks`
(`scheduling/services.py`), the ADR-0132 source of truth that keeps the CPM and
Monte-Carlo inputs from drifting (the #1185 bug class):

```python
planned_start = t.planned_start or (
    t.sprint.start_date if (t.sprint_id and not t.is_milestone) else None
)
```

Properties of the decision:

- **Synthetic, never persisted.** The value is injected onto the in-memory
  `SchedTask.planned_start` only. The engine never writes `planned_start` back
  (it writes `early_*`/`late_*`), so the stored `Task.planned_start` row stays
  `null`. The user's "no constraint set" intent, drag-to-save semantics
  (ADR-0014), and the read-only-`early_start` contract are all preserved.
- **Position-only, not span-the-sprint.** The task keeps its own `duration`/width.
  A 2-day story stays a 2-day bar placed at its sprint start — it is not stretched
  to fill the sprint. Giving stories a realistic duration is the seed/author's job,
  not the scheduler's.
- **Composes via the existing `max(es_constraints)`.** The synthetic floor is just
  one more early-start lower bound alongside `planned_start` (ADR-0014), the
  data-date floor (`status_date`, ADR-0132), and predecessor constraints. A later
  dependency still wins; a data date still prevents remaining work from being
  scheduled in the past; a future sprint still pushes planned work ahead. No new
  precedence logic.
- **Milestones are excluded.** A sprint milestone (e.g. a sprint review/demo) is a
  zero-duration gate that belongs at the *end* of the sprint, not its start, and is
  bound explicitly or via `Sprint.target_milestone` (ADR-0106). Flooring it at the
  sprint start would mis-place it, so the floor applies to schedulable
  (non-milestone) work only.
- **Engine-side semantics unchanged.** The standalone `trueppm-scheduler` package
  and the Rust/WASM engine stay sprint-agnostic — they receive a `planned_start`
  they already know how to honor. WASM conformance is untouched; the Apache-2.0
  boundary is unaffected.
- **Both engines stay in sync (#1185).** Because the floor lives in the shared
  converter, Monte Carlo floors sprint work identically to CPM. P50/P80/P95 for a
  project with sprint-planned, undated work now reflect "work cannot start before
  its sprint" — more realistic, not a regression. (Monte Carlo's committed-task
  set already excludes BACKLOG, so it mostly sees committed/in-progress sprint
  work; the deterministic CPM pass sees all of it and is what positions the Gantt.)

To read `t.sprint.start_date` without an N+1, both call sites prefetch the sprint:
the deterministic CPM task (`scheduling/tasks.py` `_run_schedule`) adds
`tasks__sprint` to its `prefetch_related`; the Monte-Carlo endpoint
(`scheduling/views.py` `run_monte_carlo`) adds `.select_related("sprint")` to its
committed-task query.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. Synthetic SNET floor in `build_sched_tasks` (chosen)** | One change in the single shared converter → CPM and MC can't drift (#1185); no engine/WASM change; no migration; nothing persisted, so drag/PATCH intent preserved | Converter must now reach the sprint (prefetch at both call sites); MC results shift for sprint-undated work (intended) |
| B. Persist `planned_start = sprint.start_date` in the importer / on sprint-assign | Visible in the API; no converter change | Only fixes seeded/imported data, not the live behavior; mutates a user field the user didn't set; fights drag-to-save; needs backfill + write paths on every sprint-assign |
| C. Frontend fallback to the sprint window in `deriveBarGeometry` | No backend change | Web-only — mobile, exports, MC, and any other API consumer stay broken; re-introduces server/client schedule divergence the API-first rule forbids |
| D. Floor inside the scheduler engine (pass sprint dates in) | Centralized in CPM | Breaks the engine's sprint-agnostic contract and the Apache-2.0 boundary; forces a Rust/WASM conformance change for a value the API can synthesize before the engine |

## Consequences
- **Easier:** hybrid schedules read correctly — sprint-planned stories sit in their
  sprint windows on the Gantt whether or not they are dated or complete. The
  Helios demo stops dog-piling 1-day squares at the origin. Monte Carlo forecasts
  for agile-planned work get more realistic start floors.
- **Harder / watch:** the schedule now has an *implicit* SNET source (sprint
  membership) in addition to the explicit `Task.planned_start` (ADR-0014). A reader
  debugging "why does this task start here" must know sprint membership can floor
  it. This is documented here and in the converter.
- **Risks:** (1) A task whose sprint window is far from where its dependencies or
  data date place it now resolves by `max()` — correct, but a PM may be surprised a
  dependency overrides the sprint floor; this matches CPM semantics and ADR-0101's
  "task slotted into a sprint but scheduled elsewhere" guardrail (the guardrail
  *warns*; this ADR *positions*). (2) Pending scope-injections (ADR-0102,
  `sprint_pending=True`) carry a `sprint_id`, so they also receive the floor; if the
  injection is rejected the task loses its sprint and reverts to the project-origin
  float — coherent. (3) MC P-values move for affected projects; acceptable and more
  accurate.

## Implementation Notes
- P3M layer: Programs and Projects.
- Affected packages: **api** only (`scheduling/services.py`, `scheduling/tasks.py`,
  `scheduling/views.py`). No change to `scheduler`, `wasm-scheduler`, `web`, or
  `helm`.
- Migration required: **no** — the floor is computed at CPM-input time and never
  persisted; all inputs (`Task.sprint`, `Sprint.start_date`) already exist.
- API changes: **no** new endpoints or fields. Existing `early_start`/`early_finish`
  values shift for sprint-assigned, undated, incomplete tasks (and their MC bands).
- OSS or Enterprise: **OSS** (`trueppm/trueppm`).
- Relationship to other ADRs: cites **ADR-0132** (parent — progress-aware pass +
  the single CPM↔MC converter; this ADR adds one term to that converter's
  `planned_start` mapping. ADR-0132 plans to rename `build_sched_tasks` →
  `build_sched_project`; this change extends the *current* converter and the floor
  moves with the rename when it lands). Amends **ADR-0014** to record sprint
  membership as a second, implicit SNET source. Cites **ADR-0102** (sprint-pending),
  **ADR-0101** (sprint/WBS guardrail — the warning counterpart), **ADR-0106**
  (agile/waterfall bridge, sprint↔milestone binding), and **ADR-0012** (Monte Carlo
  endpoint).

### Durable Execution
1. Broker-down behaviour: **N/A** — this change adds no dispatch. It only alters the
   pure CPM-input mapping *inside* the already-durable recalculation path, which is
   triggered through the existing `enqueue_recalculate` (transactional-outbox-backed,
   ADR-per-#896). No new commit-then-dispatch gap is introduced.
2. Drain task: **Reuses** the existing schedule-request drain — no new category of
   async work, so no new Beat drain.
3. Orphan window: **N/A** — no new outbox rows are written.
4. Service layer: extends the existing `scheduling/services.py::build_sched_tasks`
   converter; recalculation continues to go through
   `scheduling/services.py::enqueue_recalculate` unchanged.
5. API response on best-effort dispatch: **N/A** — no new endpoint; the recalc
   trigger already returns `{"queued": true}` (202) at its existing call sites.
6. Outbox cleanup: **N/A** — no new outbox rows.
7. Idempotency: CPM recalculation is already idempotent (a pure function of stored
   state, `bulk_update` overwrites the prior result). The synthetic floor is
   deterministic given `Sprint.start_date`, so a re-run produces byte-identical
   `early_start`/`early_finish` — duplicate executions (broker retry, manual
   re-queue) converge.
8. Dead-letter / failure handling: unchanged — an exception in the pass propagates
   to `TaskRunTracker.__exit__`, which marks the run FAILED and broadcasts
   `task_run_failed` to connected clients (existing behavior).
