# ADR-1152: CPM output is cleared when a task leaves the committed set

## Status

Accepted (2026-09-09)

## Context

Eight columns on `Task` are CPM output, written only by the scheduling engine's
write-back: `early_start`, `early_finish`, `late_start`, `late_finish`,
`scheduled_start`, `total_float`, `free_float`, `is_critical`.

Both CPM entry points schedule exactly the committed population —
`CommittedTaskManager` (`apps/projects/models.py`): not BACKLOG, not EPIC, not
`is_recurring`, not soft-deleted. `_run_schedule` and `_schedulable_tasks`
(`apps/projects/program_schedule.py`) each replicate that filter in Python so the
deterministic feed matches the manager exactly (#1772).

`_apply_cpm_results` (`apps/scheduling/tasks.py`) writes results only onto the rows
the engine returned — it `continue`s on any row absent from `result_map`. So a task
that **leaves** the committed set (groomed back to BACKLOG, retyped to EPIC, flagged
recurring, soft-deleted) is absent from every subsequent run's input and is never
revisited. Its last CPM result persists indefinitely. Nothing anywhere cleared these
fields, and because all eight are in `_HISTORY_EXCLUDED_TASK` the staleness left no
audit trail either.

#3539 fixed exactly one consumer — `capture_forecast_snapshot` now aggregates over
`Task.committed` — and in doing so demonstrated that per-consumer fixes do not
generalize. The residue it was reading is still there.

**The residue is read as current by roughly twenty aggregates**, all querying
`Task.objects.filter(project=…, is_deleted=False)` with no committed-set exclusion:
five sites in `program_rollup.py` (the "trending later than baseline" KPI, the
critical and at-risk task totals, the two health bands), nine in `views.py`, the
milestone helpers in `services.py`, `utilization.py`'s
`_compute_utilization_internal` (which feeds the resource heat map, the Overview
utilization KPI and the overallocation digest), the MS Project exporter, and the
public share-link serializer.

Two facts make the correct value unambiguous rather than a preference:

- `is_critical` is `BooleanField(null=True, blank=True)`, and the MCP read surface
  **already treats the tri-state as a contract**
  (`packages/mcp/src/trueppm_mcp/tools.py::_task_why`): `True` → on the critical
  path; `False` → not on it; `None` → "unscheduled … nothing computed to explain",
  returning `{}`. NULL already *means* "outside the schedulable set."
- Today that contract is violated in the worst direction. A BACKLOG card carrying a
  residual `is_critical=True` makes `get_task` tell an AI agent *"This task is on the
  critical path — any slip moves the project finish"* about a row CPM has never
  scheduled. The function's own docstring says it returns `{}` for an unscheduled
  task; the residue is why it does not.

Measured on the dev database: two of twenty-eight projects show the divergence in an
aggregate, and the true count is higher and unknown — a stale row whose value is
dominated by committed work contributes nothing to an aggregate and is invisible to
the detector. The concrete case: `ProjectOverviewView`'s `active_statuses` list
explicitly includes `BACKLOG`, so its `late=Count(early_finish__lt=today, …)` counts
all eight of one project's groomed-out stories as late, today, on a shipping
endpoint.

**P3M layer:** Programs and Projects (single-project and program-scoped CPM).
**Repo:** OSS — this is core single-project scheduling, with no cross-program,
portfolio, or governance surface.

## Decision

**When a task leaves the committed set, its CPM output is cleared to NULL.** An
unscheduled row carries no schedule.

The contract becomes total and statable: **each of the eight columns is non-null if
and only if the row is in `Task.committed`.**

### D1 — Scope is exactly eight fields; `duration` is not one of them

`duration` is deliberately excluded. It is `IntegerField(default=1)` — not nullable,
so "clear" would mean writing the fabricated value `1`, not an absence. It is
user-owned on every non-summary row, which the write-back never touches
(`summary_durations.get(task_key)` is keyed exclusively by summary id, so the lookup
*is* the summary test). For a summary that later exits, the engine overwrote the
value in place and retained no prior, so a "revert" could only guess. Writing `1`
would also break the canonical milestone invariant `is_milestone=True ⟺
delivery_mode='milestone' ⟺ duration=0`. And no residue consumer reads `duration` —
they read `early_finish`, `total_float` and `is_critical`.

A stale rolled-up duration on a groomed-out summary is a stale *number*, not a false
assertion about a schedule. If it matters it is its own issue with its own data
question.

### D2 — The write is a widened pass inside the recompute transaction

`_apply_cpm_results` structurally cannot do this: the exited rows are not in its
input. The clear is therefore a separate statement —
`Task.objects.filter(<outside committed>).filter(<carries any output>).update(…=None)`
— hoisted into one helper, `projects.services.clear_uncommitted_cpm_output`, called
from three places so the predicate has exactly one definition.

It runs inside the **same** `transaction.atomic()` as the CPM write-back. A client
receiving `cpm_complete` must never be able to read a state in which the plan moved
but the residue still stands.

The `.filter(<carries any output>)` guard makes the steady state a **zero-row**
statement; without it every recompute rewrites every BACKLOG card in the project.

The clear also runs on `_run_schedule`'s `if not db_tasks: return` early return. A
project whose entire committed set was groomed away is the maximal-residue case —
100% of its rows stale — and that return precedes the transaction entirely, so a
write-back-block-only fix would miss exactly the worst case. The two
`_escalate_to_program` returns deliberately clear nothing: the program pass is the
sole writer while escalation holds (ADR-0120 D3) and clears across every member
project itself.

### D3 — Clearing at each transition point was rejected on mechanism, not cost

`status` / `type` / `is_recurring` / soft-delete are written from the task serializer,
`tasks/bulk/`, MS Project import, inbound Jira sync, program moves, cascading delete,
and management commands. A `save()` override cannot see all of them:
`apps/projects/inbound_sync.py` applies its status transition as
`Task.objects.filter(pk=…).update(**update_fields)`, bypassing `save()` entirely. A
clearing rule spread across ~15 call sites is silently wrong on every one it misses,
and the next write path reopens the hole.

The recompute already *owns* these eight columns. Completing that write path is one
enforcement point instead of fifteen, and it converges no matter how the row left.

### D4 — Self-healing, with no new call sites

Every exit transition already enqueues a recompute of its project:
`_NON_SCHEDULE_TASK_FIELDS` is `{"notes", "name", "board_lane"}`, so any `status` or
`type` write recalculates; the `is_recurring` flip and task soft-delete each
recalculate explicitly. Convergence is therefore bounded by the outbox, not
open-ended.

### D5 — No `server_version` bump, and no per-task delta

The clear is the same class of write as the CPM write-back — a server-owned derived
value moving to its unset state — so it preserves the ADR-0091 carve-out and bumps
neither `server_version` nor `sync_seq`. It does not need to: the transition that
caused it goes through `save()`, bumps both, and `SyncTaskSerializer` ships a full
row, so the next pull carries the cleared values beside the new `status`. That is
precisely the channel by which the *stale* values reach an offline client today.

Cleared rows do not ride the ADR-0091 `task_dates_updated` delta. `moved_tasks` is
defined as a subset of the engine's write-back set and is counted against
`CPM_DELTA_BROADCAST_CAP`; admitting cleared rows would push a project into the
`truncated` branch on a grooming operation — the regression #2573 exists to remove.
The client learns of the change from the `task_updated` / `task_deleted` event the
transition already broadcasts (ADR-0152).

Cleared rows are likewise kept out of `tasks_to_update` and `old_cpm_dates`, so
`_build_schedule_shift_events` (ADR-0207) does not emit "moved to nothing" activity
rows. Leaving the plan is a scope change, not a schedule shift, and the board already
records it.

### D6 — Soft-deleted rows are cleared too

Including them makes the predicate the plain complement of `CommittedTaskManager` —
one expression, no carve-out. A carve-out would be a second convention to maintain
against the same consumers this decision exists to stop trusting. It also matters on
its own: a restored row would otherwise come back asserting a critical path it is not
on, and restore does not reliably trigger a recompute.

### D7 — Existing rows are backfilled

The recompute settles this only for projects that recompute *again*. A finished or
archived project never does, yet `_critical_task_total` and `_at_risk_task_total`
exclude only `COMPLETE`, so those projects are still aggregated. `projects/0150`
therefore carries a `RunPython` that clears every non-committed row already carrying
output, alongside the `AlterField`s that publish the invariant in `help_text`.

## Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| **1. Clear on exit (chosen)** | Fixes every current and future `Task.objects` consumer at once; makes the already-shipped `is_critical` tri-state true; no schema change, no new API surface | A row pulled back into the plan shows blank dates until the next recompute; the prior position is not recoverable from the row itself |
| 2. Keep, and mark stale | Destroys no information | Adds a column *and* still requires every consumer to be fixed; invents a second encoding of a distinction NULL already carries, contradicting a shipped MCP consumer; the preservation value is already served by `Baseline`/`BaselineTask` and ADR-0207 events |
| 3. Keep as-is, fix each consumer | Smallest immediate diff | ~20 fixes; the next `Task.objects` consumer reintroduces it and nothing reports the mistake; #3539 already showed it does not generalize |
| 4. Make `Task.objects` filter the committed set | One change | Breaks the Board, which must render BACKLOG cards through the default manager (ADR-0057) |

## Consequences

- **Easier:** every aggregate over `Task.objects` reads a truthful CPM value; the MCP
  read surface stops asserting critical-path membership for unscheduled rows; `NULL`
  becomes a stated invariant a new consumer can rely on rather than an accident.
- **Harder:** a row groomed out and immediately pulled back shows blank
  Start/Finish/Float until the recompute lands. The Schedule view already routes
  BACKLOG rows to the unscheduled gutter, so the visible change is confined to the
  drawer and list columns.
- **Accepted — information loss.** The previous dates are not recoverable from the
  row. `Baseline`/`BaselineTask` is the explicit snapshot mechanism and ADR-0207
  records the shift history. A live column is not an archive, and using it as one is
  what produced this defect.
- **Accepted — offline clients.** A client that misses the `task_updated` frame keeps
  a stale cached row until it re-pulls. Unchanged from today: ADR-0091's accepted
  dropped-event risk, and every value is re-derivable on refetch.
- The `help_text` addition is the user-visible half of this decision and reaches
  `docs/api/openapi.json` through drf-spectacular in the same MR.

## Implementation notes

- P3M layer: Programs and Projects. OSS.
- Affected packages: `api` only (`scheduling/tasks.py`, `projects/services.py`,
  `projects/models.py`, one migration). No web change — the clients already render
  the null case. No `packages/scheduler` or `packages/wasm-scheduler` change: this is
  a persistence-boundary decision, not an engine one, so the ADR-0015 Python/Rust
  conformance contract is untouched.
- Migration: `projects/0150` — `AlterField` ×8 (`help_text` only) plus a `RunPython`
  backfill. No constraint is added, so `api:migration-constraint-safety` does not
  apply.
- API changes: no endpoint added or removed, no field added or removed. The eight
  fields gain `help_text` documenting the invariant.
- The invariant is gated by
  `packages/api/tests/apps/scheduling/test_cpm_output_cleared_on_exit.py`, which
  builds its own fixtures. `scripts/check-forecast-snapshot-population.sh` stays
  deliberately unwired from CI and `make pre-push` — its input is a populated
  database, so in CI it is vacuous and on a developer's machine it reds on rows they
  did not create. Its header records that decision.

### Durable execution

1. **Broker-down behaviour:** N/A — the clearing write is a synchronous `update()`
   inside the already-dispatched CPM task's own transaction. It introduces no
   dispatch path.
2. **Drain task:** none. Reuses the existing `ScheduleRequest` outbox and
   `drain_schedule_queue` unchanged.
3. **Orphan window:** N/A — no new outbox row.
4. **Service layer:** unchanged — CPM continues through
   `scheduling/services.py::enqueue_recalculate()`.
5. **API response on best-effort dispatch:** N/A — no new endpoint. Grooming a task
   returns the standard task response; the clear lands with the queued recompute.
6. **Outbox cleanup:** N/A — no new outbox row.
7. **Idempotency:** inherently idempotent. Clearing an already-cleared row is a
   no-op, and the write set is filtered to rows still carrying a non-null CPM field,
   so a duplicate run writes nothing.
8. **Dead-letter / failure handling:** none new. The clear shares the CPM
   transaction, so it commits or rolls back with it; a failed run leaves the residue
   exactly as it is today and the next recompute retries.
