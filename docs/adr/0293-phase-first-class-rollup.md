# ADR-0293: Phase as a first-class rollup (emergent, not a model type)

## Status
Accepted

> Part of epic #1752 ("phase = a first-class ROLLUP, not a task-with-children").
> Child issue #1753 implements the serializer hardening recorded here; sibling
> #1755 flips phase-in-sprint from WARN to a hard block (see §Supersession).
>
> **ADR number:** `0293` was confirmed free at authoring time. The worktree
> harness reserved `0308`, but the maintainer directed this ADR to `0293` to keep
> the epic #1752 ADR contiguous with its design (ADR-0293 is referenced by the
> epic's child issues).

## Context

A "phase" in TruePPM is a WBS grouping: a parent task whose progress, dates, and
effort are the **rollup** of its child work. Until now nothing enforced that a
phase is a pure rollup — the API happily accepted a `status`, a 3-point estimate,
an assignee, or a logged time entry written *directly* onto a phase, even though
every one of those values is computed from the phase's children on read and would
be silently discarded (or double-counted) on the next rollup. The percent-complete
case was already closed (`summary_rollup_locked`, ADR-0108 §4); the others were
open holes.

The temptation is to make "phase" a stored attribute — a `task_type` enum value,
or a boolean column. Two prior decisions rule this out:

- **ADR-0024 (ltree-only hierarchy):** the WBS tree lives *only* in the
  `wbs_path` ltree column. `is_summary`, `parent_id`, and `percent_complete_rollup`
  are computed annotations, never stored. Adding a stored `is_phase` would
  duplicate hierarchy state that the ltree already fully determines, and would
  drift the moment a task is indented/outdented/reparented.
- **ADR-0058 (rejected `task_type` enum):** a dedicated structural type for
  summaries/phases was considered and rejected — the tree shape already answers
  "is this a grouping?" `Task.type` (STORY/TASK/BUG/SPIKE/EPIC) and
  `delivery_mode.MILESTONE` already exist for the *semantic* classifications that
  are genuinely orthogonal to structure; "phase-ness" is not one of them — it is
  purely a function of whether the task has structural children.

**P3M layer:** Programs and Projects (OSS). A phase is intra-project WBS structure;
it aggregates within a single project/program and never crosses the program
boundary, so it stays entirely in the OSS core.

## Decision

**Phase stays emergent and computed — no model field, no enum, no migration, no
stored column.** A phase is derived from the ltree exactly like `is_summary`, and
every "a phase must not carry X" rule is enforced in **one place**: the DRF
serializer `validate()` (and, for time, the `TimeEntry` serializer + timer-start
view). Enforcement in the serializer is deliberate (ADR-0112, API-first single
source of truth): an MCP/agent caller writing through the same endpoint is blocked
**identically** to the UI — the rule can never be bypassed by talking to the API
directly.

### The `is_phase` definition

> **A phase is a non-subtask task with at least one *structural* (non-subtask)
> child.**

Concretely, `is_phase = EXISTS(direct WBS child where is_subtask = false)`. This
is a strict refinement of `is_summary`:

| Task shape | `is_summary` | `is_phase` |
|---|---|---|
| Leaf (no children) | false | false |
| **Leaf with drawer subtasks only** (children all `is_subtask=true`) | **true** | **false** |
| Parent with ≥1 structural child | true | **true** |

The **leaf-with-subtasks** row is the critical distinction. A contributor's task
that has been broken into drawer subtasks is `is_summary=true` (it has children)
but is **not** a phase — it is still a unit of assignable, estimable, loggable
work owned by one person. It stays fully writable. Only a task with real
structural children (other non-subtask tasks) is a rollup.

`is_phase` is surfaced as a **read-only computed serializer field** (a RawSQL
`EXISTS` annotation in `annotate_tasks_queryset`, parallel to `is_summary`) on the
task serializer, and is added to `SyncTaskSerializer.Meta.fields` (annotated on the
sync pull queryset) so offline clients receive the same flag.

### Refinement vs. the narrower `is_phase` in `evaluate_sprint_guardrails`

The sprint-guardrail evaluator (`_evaluate_task_guardrails` /
`evaluate_sprint_guardrails`, ADR-0101) has a **local** `is_phase` variable
defined as "a WBS **level-1 root**" (`wbs_path` matches `^\d+$`). That narrower
definition is specific to the guardrail's "don't put a top-level phase in a
sprint" heuristic and is **not** the rollup definition. The ADR-0293 `is_phase`
is broader: **a mid-tree summary with real structural children is also a phase**
for the rollup rules — a task at `1.2` with a child at `1.2.1` is a phase and must
not carry status/estimate/assignee/time, even though it is not a level-1 root. The
guardrail local var is left as-is (its heuristic is unchanged); the rollup rules
use the structural-child probe (`task_is_phase()` in `projects.models`), which is
the single runtime source of truth shared by the projects serializer and the
time-tracking serializer/timer.

### The "a phase must not carry" table

Each rule fires **only when the request actually changes the locked attribute** on
a phase — a PATCH that omits the field, or re-sends the current value, still
succeeds (partial-update safety, mirroring `summary_rollup_locked`).

| Attribute written to a phase | Error code | Status | Where enforced |
|---|---|---|---|
| `percent_complete` | `summary_rollup_locked` | pre-existing (ADR-0108 §4) | `TaskSerializer.validate` |
| `status` | `phase_status_rollup_locked` | **new** | `TaskSerializer.validate` |
| `optimistic_duration` / `most_likely_duration` / `pessimistic_duration` | `phase_estimate_rollup_locked` | **new** | `TaskSerializer.validate` |
| `assignee` | `assignee_on_phase` | **new** | `TaskSerializer.validate` |
| logged time (manual entry, PATCH, or timer) | `time_log_on_phase` | **new** | `TimeEntrySerializer.validate` + `MeTimerStartView` |

Resource **assignment** to a summary/phase was already blocked at the
`TaskResource` create path ("summary task" error); `assignee_on_phase` closes the
parallel hole on the task serializer's own nullable `assignee` FK. The
timer-start view carries the same `time_log_on_phase` guard so the timer-stop path
(which never touches `TimeEntrySerializer`) cannot create a phase time entry.

### What a phase *keeps*

Deliberately **not** restricted, because they are legitimately derived or
aggregate concerns, not direct writes of leaf-owned values:

- **Phase → phase dependencies** — structural sequencing between groupings is
  valid scheduling input; CPM resolves them.
- **Baseline** — a phase's baseline dates are a snapshot of its rolled-up
  start/finish; capturing them is a read-through, not a direct write.
- **Monte Carlo** — a phase's risk distribution is aggregated from its children's
  distributions; it is an output, not an input.

## Supersession of ADR-0101 (phase-in-sprint)

ADR-0101 made "assign a phase to a sprint" an **advisory WARN** by default
(escalatable to BLOCK per project policy). Under the first-class-rollup model a
phase is definitionally not sprintable work — it has no own status/estimate/
assignee to burn down. Sibling issue **#1755** therefore promotes phase-in-sprint
to a **hard block**, superseding the ADR-0101 warn default for this rule.
**ADR-0293 is the record of that supersession**; #1755 implements it. (The other
ADR-0101 composition guardrails are unaffected.)

## Alternatives Considered

1. **Stored `is_phase` boolean / `task_type=PHASE` enum.** Rejected — violates
   ADR-0024 (hierarchy is ltree-only) and re-litigates ADR-0058. It would drift on
   every reparent and require a migration + backfill + a trigger to stay correct,
   to represent a fact the ltree already determines for free.
2. **Enforce in the model `save()` / a DB constraint.** Rejected — a DB constraint
   cannot express "has a structural child" without a trigger, and model-level
   enforcement bypasses the structured DRF error codes the frontend maps to its
   lock affordances. The serializer is the API-first single source of truth
   (ADR-0112); a model-layer check would also fire on internal rollup writes.
3. **Frontend-only disable of the controls.** Rejected outright — it leaves the
   API and every MCP/agent caller unguarded. The whole point (ADR-0112) is that
   the *server* is the boundary.
4. **Block phase → phase dependencies / baseline / Monte Carlo too.** Rejected —
   those are derived/aggregate, not direct writes of leaf-owned values (see "What
   a phase keeps").

## Consequences

- **Positive:** the "phase is a rollup" invariant is now enforced at the API
  boundary for every caller (UI, MCP, agent, sync client). No model change, no
  migration, no new stored state to keep consistent. `is_phase` is a first-class
  server fact an agent can read to know a task is a rollup, satisfying the
  AI-readiness "values are server-side" principle.
- **Negative / cost:** each locked write on a task now runs one extra `EXISTS`
  child probe *only when a locked field is in the payload* (lazy) — negligible and
  parameterized. A caller that previously (incorrectly) wrote status/estimate/
  assignee/time to a phase now gets a 400 with a stable code; the frontend maps
  these to lock affordances (tracked in the epic's UI child).
- **P3M layer:** Programs and Projects (OSS). Intra-project WBS; never crosses the
  program boundary.
- **Reconcile note (#1750 / !1167):** bug #1750 (OPEN, not on main) introduced a
  drawer "structural child" distinction. This ADR implements its own structural-
  child probe independently; if #1750 merges first a light rebase-reconcile of the
  probe may be warranted (converge on one helper).

### Durable Execution

This change is **pure synchronous serializer validation** — it adds no async side
effect. Every subsection is therefore N/A, with justification:

1. **Broker-down behaviour:** N/A — the phase locks are synchronous read-only
   `EXISTS` probes inside `validate()`; no task is enqueued, so there is nothing to
   dead-letter when the broker is down. A rejected write returns a 400 inline.
2. **Drain task:** N/A — no outbox row, no drain. Validation runs in-request.
3. **Orphan window:** N/A — no outbox/drain rows are created.
4. **Service layer:** The shared `task_is_phase()` probe lives in
   `projects.models` and is a plain synchronous query helper; it dispatches
   nothing.
5. **API response on best-effort dispatch:** N/A — the endpoints return a
   synchronous 200/201 (accept) or 400 (reject), never a queued 202.
6. **Outbox cleanup:** N/A — no outbox rows introduced.
7. **Idempotency:** The locks are pure functions of the request + current DB
   state; re-sending the same PATCH yields the same result. A no-op write (same
   value) is explicitly allowed, so idempotent replays succeed.
8. **Dead-letter / failure handling:** N/A — synchronous request; standard DRF
   error responses. No task, no retry, no DLQ.
