# ADR-0210: Dead-letter write actions — requeue via workflow backend, drop with audit note, bulk-over-filter

## Status
Proposed

Extends ADR-0080 (durable workflow execution — this registers the *first* consumer
workflow against its registry), ADR-0172 (System Health operator UI — this is the
write surface that ADR-0172 §1 explicitly deferred to 0.4/#652), and ADR-0084
(dead-letter alerting — "no silent discards").

## Context

Epic #691 adds a workspace-admin "System Health" operator UI. ADR-0172 shipped the
**read-only** surfaces in 0.2 (overview dashboard #692, dead-letter inspector #694)
and explicitly deferred the **write** actions to 0.4/#652:

> The viewset's existing `retry`/`dismiss` write actions remain on the backend but
> are **not wired into the 0.2 UI** (deferred to 0.4, #652).

#695 is that write slice. An operator triaging a dead-lettered task needs to:

- **Requeue with backoff** (single): re-enqueue a parked message after an
  operator-chosen delay (e.g. 5 m).
- **Drop with note** (single): remove a parked message from the active queue with an
  optional audit note.
- **Drop all / Requeue all** over the **current filter set** (e.g. "all 7 routed to
  the vendor relay").

The `FailedTaskViewSet` already carries two write actions — `retry` and `dismiss` —
but both are inadequate for #695:

1. `retry` re-dispatches via `current_app.send_task(...)` **directly** — a side
   channel with no durability. If the broker is down at that instant the DB is
   untouched but the re-enqueue is silently lost. #652 shipped precisely the
   mechanism that fixes this class of gap: the outbox-composing default workflow
   backend (ADR-0080). #695 is *gated on* #652 because requeue must round-trip
   through that durable backend, not the side channel.
2. `dismiss` has no note, no operator, no timestamp — it cannot satisfy the
   "auditable" requirement or ADR-0084's "no silent discards" principle.
3. Neither action supports a backoff, and there is no bulk action.

**Backend reality that shapes the design.** A `FailedTask` is a generic *Celery*
dead-letter (`task_name`, `args`, `kwargs`, `exception_*`, `failure_count`,
`status ∈ {pending_retry, dead, dismissed, retried}`). It is **not** a
`WorkflowInstance` — so requeue cannot "resume a failed workflow"; it must
**re-dispatch the original Celery task**, but do so *through* the durable backend
rather than around it.

**#652 backend shape (ADR-0080 §A/§D).** `trueppm_api.workflows.services.start_workflow(name, input, *, idempotency_key)`
starts a registered `WorkflowDefinition`. `start_workflow` → `enqueue_step` writes a
`WorkflowOutboxRow` inside `transaction.atomic()` and dispatches it via
`transaction.on_commit()`; `workflows_outbox_drain` (Beat, 30 s) re-dispatches
stranded rows. Activities are once-and-only-once at `(workflow, activity_name,
input_hash)`. There are **no** consumer workflows registered yet — #695 registers the
first. A known v1 limitation (ADR-0080, `workflow_engine.tasks._do_timer_drain`
docstring): **mid-chain durable `sleep` does not resume the chain** — "v1 linear
chains do not sleep."

**P3M layer:** Operations (single-deployment operator hygiene), OSS — same
classification as ADR-0172. This is not cross-program governance; it serves the
self-hosting operator of one workspace.

## Decision

### 1. Requeue round-trips through the #652 workflow backend (first consumer workflow)

Register the first OSS consumer workflow,
`scheduling.requeue_failed_task`, under the ADR-0080 registry:

```python
# trueppm_api/workflows/consumers/requeue_failed_task.py
class RequeueFailedTaskWorkflow(WorkflowDefinition):
    name = "scheduling.requeue_failed_task"
    # one step: "redispatch" → re-enqueue the original Celery task
```

The single activity delegates the actual Celery `send_task` to a scheduling service
wrapper (`scheduling.services.redispatch_dead_lettered_task`) — the consumer file
never imports `celery` directly (ADR-0080 §E import discipline; the celery import
lives behind the service boundary). The workflow is registered from
`SchedulingConfig.ready()` (an `AppConfig.ready()`, matching ADR-0080's registry
note; the scheduling app already touches Celery in `ready()`, so ownership is
cohesive there rather than in `workflow_engine`).

The `requeue` viewset action calls:

```python
start_workflow(
    "scheduling.requeue_failed_task",
    {"failed_task_id": ..., "task_name": ..., "args": ..., "kwargs": ...,
     "backoff_seconds": ...},
    idempotency_key=f"requeue:{failed.id}:{failed.failure_count}",
)
```

**Why a workflow and not "just an outbox row".** The requirement is to round-trip
through the backend #652 shipped, not to hand-roll a parallel outbox. Going through
`start_workflow` buys, for free: the workflow outbox + drain (durability), OAOO
activity idempotency, a `WorkflowInstance` + `WorkflowHistoryEvent` audit trail of
the operator action, and the extension point every future durable-execution consumer
uses. It also validates the ADR-0080 registry against its first real consumer.

### 2. Backoff = Celery `countdown` on the re-dispatched task; durability via the outbox

The operator picks a backoff from a bounded set (None / 5 m / 30 m / 1 h). It is
passed as `backoff_seconds` in the workflow input and applied as a Celery `countdown`
on the re-dispatched task inside the activity:

```python
current_app.send_task(task_name, args=args, kwargs=kwargs, countdown=backoff_seconds or None)
```

**Why not a durable workflow `sleep`?** ADR-0080's v1 backend does not resume a chain
after a mid-chain `sleep` (documented limitation). Using `sleep` would strand the
requeue in `SLEEPING` forever. The honest v1 story: the **re-enqueue itself is
durable** (the workflow outbox guarantees the redispatch activity runs even across a
broker outage — the drain re-dispatches), while the **delay** is a best-effort Celery
countdown (broker-side; a broker restart during the countdown window can drop the
delayed task). This is strictly better than today's side channel, which has no
durability at all. When v1 gains chain-resuming timers, the backoff can migrate to a
durable `sleep` with no API change (the operator contract is unchanged). Recorded so
the trade-off is not re-litigated.

### 3. "Drop with note" is a soft-remove (DISMISSED + audit stamps), never a hard delete

Drop transitions the row to `DISMISSED` and stamps three **new, nullable** audit
fields on `FailedTask` (migration 0010):

| Field | Type | Purpose |
|---|---|---|
| `resolution_note` | `TextField(blank=True, default="")` | operator note on drop |
| `resolved_by` | `FK(AUTH_USER_MODEL, null=True, on_delete=SET_NULL, related_name="+")` | operator who acted |
| `resolved_at` | `DateTimeField(null=True, blank=True)` | when the operator acted |

The row is **retained** (removed only from the operator's default active view, which
filters to `dead`/`pending_retry`), so the audit note survives — a hard `DELETE`
would destroy the very audit the issue asks for, and violates ADR-0084's "no silent
discards." Retention purge eventually reclaims dismissed rows on the existing nightly
schedule. `resolved_by`/`resolved_at` are also stamped on **requeue** (note empty),
so both operator actions are attributable. All three fields are nullable / defaulted —
no NOT NULL without default.

### 4. Bulk actions operate over the current filter set, bounded

`requeue_all` and `drop_all` are `detail=False` POST actions that reuse the inspector's
existing `get_queryset` query-param filters (`status`, `task_name`, `failed_after`,
`failed_before`) — "the current filter set" is exactly what the operator sees. Both
are **bounded** to `FAILED_TASK_BULK_ACTION_MAX` (default 500, oldest-first): if the
filtered set exceeds the cap, the action processes the first N and returns
`{"processed": N, "capped": true}` so the operator repeats rather than the server
unbounded-loading the table. Only requeueable/active rows (`dead`, `pending_retry`)
are acted on; already-terminal rows in the set are skipped and counted.

- `drop_all`: a single bounded `UPDATE ... SET status=DISMISSED, resolution_note,
  resolved_by, resolved_at WHERE id IN (<=500 ids)` — no per-row Python loop, no N+1.
- `requeue_all`: iterates the bounded id set, calling `start_workflow` per task. Each
  start is its own small transaction (nested savepoint under `ATOMIC_REQUESTS`); the
  `on_commit` dispatches fire after the request commits. 500 `.delay()` calls is a
  bounded, admin-initiated cost.

### 5. Idempotency — three layers

1. **HTTP**: the viewset already mixes in `IdempotencyMixin` — an `Idempotency-Key`
   header replays the stored response, so a double-clicked requeue/drop is a no-op.
2. **Workflow**: `start_workflow(idempotency_key=f"requeue:{id}:{failure_count}")` —
   a duplicate start of the same observed failure collides on
   `WorkflowInstance.idempotency_key` and returns the existing instance instead of
   enqueuing twice.
3. **Status guard**: `requeue` only acts on `dead`/`pending_retry`; after requeue the
   row is `RETRIED`, so a second requeue is a 409/400. `drop` on an already-dismissed
   row is a no-op.

### 6. Authorization — `IsAdminUser` (Django `is_staff`)

Every action keeps `permission_classes=[IsAdminUser]`, consistent with ADR-0172 §5 and
ADR-0081/0084. Single-deployment OSS operator hygiene has no project in scope; this is
the workspace-admin gate, not project 5-role RBAC. Non-admins get 403.

### 7. Audit / broadcast

`FailedTask` is **not** board-scoped, so `broadcast_board_event()` is **N/A** — there
is no board channel to fan out to, and the System Health UI polls (10 s refetch / cache
invalidation) rather than subscribing over WebSocket. The operator action is made
observable through three durable records instead: the `resolved_by`/`resolved_at`/
`resolution_note` stamps on the row, the `WorkflowInstance` + `WorkflowHistoryEvent`
trail for requeue, and a structured log line per action. The note is **user input** —
it is bounded (`max_length` on the serializer), trimmed, stored as data (never
interpolated into task args or a shell), and rendered as text (React escapes), so it
carries no injection surface.

### 8. Endpoint naming

The write actions are named for the operator's vocabulary: `requeue` (replacing the
legacy `retry`) and `drop` (replacing the legacy `dismiss`), plus `requeue_all` /
`drop_all`. The legacy `retry`/`dismiss` actions had **zero** consumers (no test, no
frontend — #694 was read-only) and their side-channel/note-less behaviour is exactly
what #695 fixes, so they are removed rather than kept as confusing aliases. This is a
schema change (the OpenAPI paths change); acceptable in alpha and caught by the schema
drift gate.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Requeue via `start_workflow` (chosen)** | Rounds through #652's durable backend; free outbox/drain durability, OAOO, workflow audit trail; exercises the ADR-0080 registry with its first real consumer | Registers a workflow for a one-step re-dispatch (small ceremony); backoff is a countdown, not yet a durable sleep |
| Keep `current_app.send_task` (side channel) | Trivial; no new workflow | The exact durability gap #652 exists to close; broker-down loses the requeue; not "round-trip through the backend" — fails the issue's hard requirement |
| Hand-roll a new scheduling outbox row for requeue | Durable without a workflow | Reinvents #652's outbox in parallel; two outboxes to reason about; ignores the shipped backend; no OAOO/audit for free |
| Durable workflow `sleep` for backoff | Fully durable delay | v1 backend does not resume a chain after `sleep` — would strand the workflow; not available until a later engine enhancement |
| Hard-`DELETE` on drop | Row really gone | Destroys the audit note the issue requires; violates ADR-0084 "no silent discards"; nothing to attribute |
| Unbounded bulk (act on the whole filter set) | Simplest semantics | Unbounded DB load / dispatch storm on a large parked queue; a "drop all" on a mature install could lock the table |

## Consequences

**Easier:**
- Requeue is durable end-to-end — a broker outage no longer silently loses an operator
  re-enqueue (the outbox drain recovers it).
- Every drop is attributable and auditable (who, when, why) without a separate audit
  model — the fields live on the row that already exists.
- The ADR-0080 workflow registry gets its first real consumer, validating the extension
  point before the 0.5 notification-fan-out migration.
- Bulk triage over a filter ("all 7 to the vendor relay") is one click, bounded.

**Harder:**
- A one-step re-dispatch now carries workflow machinery (instance, outbox row, history)
  — heavier than a bare `send_task`, justified by durability + audit.
- The backoff is honest-but-partial in v1 (durable re-enqueue, best-effort delay) — the
  limitation must be documented in admin docs so operators don't assume a 1 h backoff
  survives a broker restart.
- Bulk requeue can enqueue up to 500 workflow starts per call — bounded, but a real
  spike the drain and worker must absorb.

**Risks:**
- **Countdown loss on broker restart** during the backoff window — mitigated by the
  outbox making the *re-enqueue* durable (the delayed task is re-derivable state, and
  worst case the operator re-requeues); documented as a known v1 limitation with a
  clean migration path to durable `sleep`.
- **Bulk cost** — mitigated by the 500 cap + oldest-first + `capped` flag.
- **ADR number**: 0210 verified free (max on `origin/main` is 0208) via
  `git ls-tree origin/main -- docs/adr`. If a concurrent branch claims 0210 before
  merge, renumber to the next free above the merged max.

## Implementation Notes
- **P3M layer:** Operations (single-deployment operator hygiene).
- **Affected packages:** `api` (`apps.scheduling`: FailedTask fields + migration 0010,
  viewset actions, serializers, `services.redispatch_dead_lettered_task`;
  `workflows/consumers/requeue_failed_task.py` — first consumer; `SchedulingConfig.ready()`
  registration), `web` (action bar + confirm dialogs + mutation hooks on the #694
  inspector, regenerated nothing in `types.ts` — hooks are hand-declared), `docs`
  (`docs/administration/` System Health / dead-letter page + `docs/api/`).
- **Migration required:** **yes** — scheduling 0010, three nullable/defaulted fields on
  `FailedTask`. No destructive op, no NOT NULL without default.
- **API changes:** **yes** — `POST /api/v1/admin/failed-tasks/{id}/requeue/`,
  `POST .../{id}/drop/`, `POST /api/v1/admin/failed-tasks/requeue_all/`,
  `POST .../drop_all/`; legacy `retry`/`dismiss` removed. All `IsAdminUser`.
- **OSS or Enterprise:** **OSS** (trueppm-suite). `grep -r "trueppm_enterprise" packages/`
  stays zero in OSS code.

### Durable Execution
1. **Broker-down behaviour:** Requeue writes a `WorkflowInstance` + `WorkflowOutboxRow`
   inside the request transaction and dispatches on `transaction.on_commit()`. If the
   broker is down at dispatch, the row persists and `workflows_outbox_drain` re-dispatches
   it — the re-enqueue is durable (unlike the removed `send_task` side channel). The
   backoff `countdown` on the *final* re-dispatched task is best-effort (broker-side).
2. **Drain task:** Reuses the existing `workflows_outbox_drain` (ADR-0080 §D) — the
   requeue is an ordinary workflow, so its step rows drain like any other. No new drain.
3. **Orphan window:** Reuses the workflow outbox's existing 5 min orphan / 10 min
   recovery windows — no new dispatch category, so no new threshold.
4. **Service layer:** `start_workflow` (via `trueppm_api.workflows.services`) for the
   requeue; new `scheduling.services.redispatch_dead_lettered_task(task_name, args,
   kwargs, countdown)` as the Celery side-effect boundary the activity calls.
5. **API response on best-effort dispatch:** `requeue` returns `200` with the updated
   `FailedTask` plus `{"workflow_id": "<id>"}` (the workflow started; the actual
   re-dispatch is async). Bulk returns `{"processed": N, "capped": bool}`.
6. **Outbox cleanup:** Requeue workflow outbox/history rows are purged by the existing
   `purge_old_workflow_records` (7 d outbox, 30 d history). Dismissed `FailedTask` rows
   are reclaimed by the existing dead-letter retention. No new purge.
7. **Idempotency:** Three layers — HTTP `Idempotency-Key` (IdempotencyMixin), workflow
   `idempotency_key=f"requeue:{id}:{failure_count}"` (unique `WorkflowInstance` key), and
   the `dead`/`pending_retry` status guard. A duplicate requeue collides on the workflow
   key and does not double-enqueue; the redispatch activity is OAOO on top of that.
8. **Dead-letter / failure handling:** If the *requeue workflow itself* fails, it enters
   `WorkflowStatus.FAILED` with the error in its history (ADR-0080 §8) — the original
   `FailedTask` is unaffected and can be requeued again. The original re-dispatched task,
   if it fails again, dead-letters back into `FailedTask` via the existing
   `record_failed_task` on_failure path (`failure_count` bumps), returning to the queue —
   the loop is closed, no silent discard.
