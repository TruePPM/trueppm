# ADR-0132: Data-Date-Aware (Progress-Aware) Forecasting

## Status
Proposed

## Context

The scheduling engine — both the deterministic CPM pass (`schedule()`) and the
Monte Carlo simulation (`monte_carlo()`) — forecasts every project **as if it
were starting from scratch on its original `start_date`**. It does not account
for which tasks are open vs. closed, how far in-progress work has burned down, or
that "today" is later than the project start. There is no concept of a **data
date / status date**.

Concretely (confirmed in code):

- `percent_complete` is a RESERVED field on the scheduler `Task` dataclass in
  **both** the Python package (`packages/scheduler/.../models.py:99`) and the
  Rust/WASM engine (`packages/wasm-scheduler/src/models.rs:63`). It round-trips
  for API parity but neither `schedule()` nor `monte_carlo()` consumes it.
- `actual_start` / `actual_finish` exist on the Django `Task` model
  (`projects/models.py:1171-1172`, added by ADR-0023) but are **never passed**
  to the scheduler.
- Every MC iteration walks the entire committed network in topological order and
  samples each task's **full** duration from `project.start_date`
  (`engine.py:1239`). Completed tasks are re-rolled rather than pinned to their
  actual finish; in-progress tasks contribute their whole estimate again.
- There is no per-project status/data date anywhere in the stack.

The user-visible symptom that surfaced this: on the Migration Tooling demo, the
Monte Carlo readout forecast a finish two months *before* the deterministic CPM
finish. The immediate cause was a separate bug — MC dropped the `planned_start`
floor (#1185, fixed) — but the deeper gap is that the engine is a *planning*
engine, never made *progress-aware*. For a tool positioning against MS Project /
Planview, data-date forecasting ("given where we actually are today, when will
we finish?") is table stakes for in-flight tracking, not a nice-to-have.

**P3M layer:** Programs and Projects (single-project forecasting). This is
**OSS** — a PM/team needs accurate in-flight forecasts to run their program; it
is not cross-program governance.

## Decision

Make both `schedule()` and `monte_carlo()` **data-date-aware**, so the Gantt
bars and the Monte Carlo band reflect the same progress-adjusted reality.

### 1. Explicit per-project status date (null → today)

Add `Project.status_date` — a nullable, PM-settable `DateField`. When **null**,
the engine anchors to the server's current date at compute time (zero-setup
out-of-box correctness). When **set**, the engine anchors to it, giving
reproducible/frozen forecasts for reporting. The default lives in the
serializer/compute path, **not** as a model-level `default=date.today` (which
would bake a runtime callable into a migration snapshot).

### 2. Progress-aware forward pass (both engines)

For each committed task, in the forward pass / sampling:

- **Completed** (`actual_finish` set, or `status == COMPLETE`) → pinned:
  `early_start = early_finish = actual_finish`. In MC, zero duration variance —
  not re-sampled. The pinned date is a hard constraint that anchors successors.
- **In progress** (`actual_start` set, not complete) → `early_start` floored at
  `max(actual_start, predecessor constraints)`; the task contributes only its
  **remaining** duration (see §3). It is *not* floored at the status date — work
  already underway stays where it actually started.
- **Not started** → floored at `max(status_date, planned_start, predecessor
  constraints)`. Future work cannot be scheduled in the past.

`percent_complete` graduates from RESERVED to **consumed**. Progress-awareness
is **always-on**: fixtures with default progress fields (`percent_complete == 0`,
no actuals) produce byte-identical output to today, so existing behavior is
preserved; the only change is for tasks that carry progress — which today is a
documented no-op. The `trueppm-scheduler` PyPI package takes a **minor version
bump** with a changelog note.

### 3. Remaining-duration derivation

- **Waterfall / deterministic / PERT** — remaining factor `f = 1 − clamp(pct,
  0, 100)/100`. The deterministic duration and **all three PERT points**
  (optimistic / most-likely / pessimistic) scale by `f`, preserving the
  distribution shape on the remaining work. Computed **inside the engine** from
  `percent_complete`, so the rule is single-sourced and conformance-tested in
  both Python and Rust.
- **Agile / velocity (#411)** — use the existing `Task.remaining_points`
  (live burndown) instead of `story_points` when sampling sprints-to-completion
  for an in-progress SCRUM task. This mapping is applied in the shared API
  input-builder (§4), since `remaining_points` is a Django-side concept.

### 4. Single shared input-builder (closes the #1185 bug class)

Introduce `build_sched_project(db_project, db_tasks, db_deps, *, status_date)`
in `scheduling/services.py`, returning a fully-formed scheduler `Project`. Both
the deterministic CPM pass (`scheduling/tasks.py`) and the MC endpoint
(`scheduling/views.py`) call it. Today these two build `SchedTask` lists
**separately and have drifted** — that drift *is* #1185 (MC silently omitted
`planned_start`). A single builder makes it structurally impossible to feed a
field to one engine and not the other: milestone zeroing, the suggest-approve
estimate gate, `planned_start`, `actual_start`/`actual_finish`, and the
`remaining_points` mapping all live in one place.

### 5. WASM conformance (staged)

The Python `schedule()` change ships first. The Rust/WASM forward pass gains the
same pinning/remaining logic plus new conformance fixtures **as a fast-follow**
(#1187). This is safe under the `wasm:conformance` gate because the existing
fixtures carry no progress fields and therefore still produce identical output
in both engines — the gate stays green. The interim consequence: server-side CPM
is progress-aware while the browser's WASM drag-*preview* is not, for projects
that have actuals. The server is authoritative (ADR-0015 already treats WASM as a
preview/partial engine); the ADR documents the gap and #1187 closes it.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Data-date model (chosen)** | Correct EVM forecasting; pins past, randomizes future; consistent CPM+MC | Touches core IP in two engines; needs conformance work |
| Pin completed only (no remaining-duration) | Simpler; fixes worst symptom | In-progress tasks still over-forecast; looks wrong the moment anyone has WIP |
| Implicit server-now status date | No DB column | Forecasts not reproducible; no PM control for reports |
| Opt-in `progress_aware` engine flag | Safer for external PyPI consumers | Extra param threaded through both engines + double the conformance fixtures, for a field that is a documented no-op today |
| Explicit `remaining_duration` field on Task | PM can override remaining directly | New synced column + serializer + UI; `percent_complete` derivation covers the 0.3 need — deferred |

## Consequences

**Easier:**
- In-flight forecasts finally answer "when will we finish *from here*."
- The shared builder removes an entire class of CPM↔MC input-parity bugs (#1185).
- Gantt bars and the MC band agree because both consume the same progress-aware
  pass.

**Harder / risks:**
- Core-IP change to the forward pass — high correctness bar. Mitigated by
  engine unit tests + the existing differential CPM-vs-MC fuzz harness.
- Temporary WASM preview divergence until #1187 (documented, server-authoritative).
- `percent_complete` becoming load-bearing means the `status ⇄ percent_complete`
  consistency logic (model coerces REVIEW/COMPLETE → 100) now has scheduling
  consequences; covered by edge-case tests below.
- Out-of-sequence actuals can produce **negative float** (a task that finished
  before its predecessor). This is correct EVM reality and is surfaced, not
  "corrected."

**Edge cases (specified, with tests):**
- *Completed task, actual_finish in the future* → pinned to the given date
  (actuals are trusted); it floors successors accordingly.
- *Completed task, actual_finish before predecessors* → pinned anyway; successor
  float may go negative. Not an error.
- *In-progress at 100% but status still IN_PROGRESS* → remaining factor 0 →
  behaves as a zero-remaining task anchored at `max(actual_start, status_date)`.
- *status_date earlier than some actual dates* → actuals win (pinned); status
  date floors only not-started/future work.
- *Out-of-sequence progress* (task started before its predecessor finished) →
  allowed; pinned/floored to its actual, not blocked.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: scheduler, wasm-scheduler (staged, #1187), api, web (labeling)
- Migration required: **yes** — `Project.status_date` (nullable DateField,
  additive, no data migration). Verify the `projects` migration number at
  branch-cut (rapid migration activity in this repo).
- API changes: **yes** — `ProjectSerializer` gains `status_date` (read/write,
  null → today on compute). MC and CPM now consume progress fields via the
  shared builder. `MonteCarloRun` records the `status_date` used (provenance;
  additive on Proposed ADR-0175).
- OSS or Enterprise: **OSS** (`trueppm-suite`).

### Durable Execution
1. **Broker-down behaviour:** N/A for MC (synchronous read endpoint, no async
   side effect). For CPM, unchanged — recompute continues to route through the
   existing transactional-outbox path (`scheduling/services.py::enqueue_recalculate`
   → `ScheduleRequest`), never a bare `.delay()`. Setting `status_date` triggers a
   recompute the same way any schedule input does.
2. **Drain task:** Reuses the existing schedule-request drain; this ADR adds no
   new category of async work, only new *inputs* to the existing CPM job.
3. **Orphan window:** N/A — no new outbox category; the existing schedule-request
   drain threshold applies unchanged.
4. **Service layer:** New `build_sched_project()` in `scheduling/services.py`
   (pure input construction, not a dispatch path). CPM dispatch stays on
   `enqueue_recalculate()`.
5. **API response on best-effort dispatch:** N/A — MC stays synchronous
   (returns the result body). A `status_date` PATCH returns the updated project
   and enqueues a recompute exactly as other schedule-affecting edits do.
6. **Outbox cleanup:** N/A — no new outbox rows; existing purge schedule covers
   schedule requests.
7. **Idempotency:** CPM recompute is idempotent on `project_id` (recomputes
   from current task state; running twice yields the same result). MC is a pure
   read. The progress-aware pass is deterministic given (tasks, deps, status_date,
   seed).
8. **Dead-letter / failure handling:** Unchanged — CPM recompute failures use
   the existing schedule-request retry/dead-letter handling. Invalid progress
   input (e.g. actual_finish out of the representable range) raises the engine's
   existing `InvalidScheduleInput`/`ValueError`, surfaced as a 400 by the MC
   endpoint, never a 500.
