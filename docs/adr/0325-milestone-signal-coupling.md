# ADR-0325: A milestone is one canonical coupled state, not three independent signals

## Status
Accepted

> Resolves issue #1773 (2026-07-09 full-application audit, domain-model track).
> **ADR number:** `0325` was reserved for this worktree by the `wt` harness.

## Context

Three columns on `Task` each independently encoded "this is a milestone", and
nothing kept them in agreement:

- `is_milestone` (boolean) — set by the PM or preserved on MS Project / P6 import.
- `delivery_mode = 'milestone'` (one of the `DeliveryMode` choices, ADR-0036).
- `duration = 0` — the zero-length-gate convention.

Different consumers keyed off different signals:

- The phase percent/weight **rollup SQL** (`views.py`) weights a child at `0`
  only when `delivery_mode = 'milestone'`.
- **Sprint targeting** (`Sprint.target_milestone`), the milestone rollup
  (`recompute_milestone_rollup`), and milestone listing key off `is_milestone`.
- The **CPM boundary** (`scheduling/services.py`) re-derives a zero duration from
  `is_milestone`, ignoring `delivery_mode` and the stored `duration`.
- The **MS Project importer** wrote `is_milestone` and a raw `duration` via
  `bulk_create` and never set `delivery_mode`, so every imported milestone had
  `is_milestone = True` but `delivery_mode = 'waterfall'`.

The result was a task that reads as a milestone on one surface and an ordinary
task on another. The serializer only ever enforced a one-way clamp
(`is_milestone → duration = 0`), and `bulk_create` bypassed even that. The model
docstring compounded the confusion by asserting `duration = 0` was *not* the
canonical signal while the runtime (serializer clamp + CPM boundary) treated it
as exactly that.

Two related holes made the divergence worse: a milestone could acquire children
(nothing blocked create-with-parent / indent / reparent under it), and a
milestone that a live sprint targeted could be silently un-flagged, leaving the
sprint's `target_milestone` FK dangling and its rollup vanishing.

## Decision

**A milestone is a single canonical state: `is_milestone = True` iff
`delivery_mode = 'milestone'` iff `duration = 0`.** Every write path normalizes
to it rather than trusting one field.

1. **Couple the signals in `TaskSerializer.validate()`.** Whichever of
   `is_milestone` / `delivery_mode` the caller sends is authoritative and the
   other is synced to match; the effective milestone state then forces
   `duration = 0`. Sending both with conflicting values (e.g.
   `is_milestone = True` with `delivery_mode = 'scrum'`) is rejected with the
   stable field code `milestone_signal_conflict`. Un-flagging drops
   `delivery_mode` back to the `WATERFALL` default.

2. **Couple the same state in every non-serializer mint path.** The MS Project
   importer writes a `<Milestone>` task with `duration = 0` and
   `delivery_mode = 'milestone'` (a later PATCH no longer silently re-zeros a
   non-zero imported duration and shifts dates). The remaining ORM-direct mints
   that `bulk_create`/`create` past the serializer are coupled the same way:
   sprint-to-milestone promotion (`_create_milestone_for_sprint`), recurring-task
   occurrence spawn (copies the template's `delivery_mode`), the template/seed
   importer, and the demo seed command. Only then is the "the DB can only hold the
   coupled state" claim actually true — a sprint-promoted milestone in particular
   is exactly the sprint-targeted case the phase rollup weights on `delivery_mode`.

3. **A milestone cannot acquire children.** `perform_create` (create-with-parent),
   `TaskIndentView`, and `TaskReparentView` reject a move that would place a task
   under a milestone, with code `child_of_milestone`.

4. **A sprint-targeted milestone cannot be un-flagged.** Removing the milestone
   flag (directly, or by flipping `delivery_mode` off `'milestone'`) while a live
   `Sprint.target_milestone` references the task is rejected with code
   `milestone_targeted_by_sprint` — mirroring the existing `milestone_rollup_locked`
   percent-lock pattern (ADR-0074). Unlink or close the sprint first.

### Why couple rather than collapse to one field

Collapsing `is_milestone` and `delivery_mode='milestone'` into a single column is
the cleaner long-term model, but it is a breaking schema change that touches the
rollup SQL, the CPM boundary, sprint targeting, the importer/exporter, the sync
serializers, and every enterprise consumer registered against these fields.
Coupling at the write boundary closes the correctness hole now, before beta,
with no migration and no change to the read-side contract. A future collapse
remains open and is out of scope here.

### Chosen duration invariant

`duration = 0` for milestones — the state the serializer already clamped to and
the CPM boundary already forced. The model docstring, which previously claimed a
milestone could carry a non-zero duration, is corrected to state the coupled
invariant.

## Consequences

- The database can no longer hold a "half-milestone"; rollup, CPM, and sprint
  code now agree on every task.
- Three new stable, MCP/agent-reachable rejection codes:
  `milestone_signal_conflict`, `milestone_targeted_by_sprint`,
  `child_of_milestone`.
- No schema migration (the change is validation + a docstring, not a field).
- Enterprise code that reads `delivery_mode` or `is_milestone` continues to work
  unchanged; the two are now guaranteed consistent.
- A future single-field collapse is still possible and is deliberately deferred.
