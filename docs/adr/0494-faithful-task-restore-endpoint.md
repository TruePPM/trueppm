# ADR-0494: Faithful Task Restore Endpoint

## Status
Accepted

Builds on **ADR-0202** (soft-delete / sync tombstone re-materialization) and
mirrors the project restore precedent (#1113). **Deliberately does NOT emit a
`task.restored` webhook** — see §4; that would consume the last OSS webhook cap
slot (19→20) and amend ADR-0083, a governance decision left for a separate,
explicit sign-off. The in-app undo is fully faithful without it (WS + recalc).

## Context

Deleting a task soft-deletes a whole graph, not a row. `Task.soft_delete()`
(`projects/models.py:2407`) tombstones: (a) every `Dependency` edge where the task is
predecessor **or** successor; (b) recursively, the task's `is_subtask=True` descendants
under `wbs_path__startswith=self.wbs_path + "."` (WBS-structure children are *not*
cascaded — the PM deletes those explicitly). Resource assignments (`TaskResource`) are
left on the tombstoned rows untouched. It then calls `VersionedModel.soft_delete()`,
which sets `is_deleted`, bumps `server_version`, and records `deleted_version`.

The web "Undo" that follows a delete does **not** reverse any of this. On both surfaces
that offer it — `ScheduleView.performBuildModeDelete` (`ScheduleView.tsx:1095`) and,
implicitly, GridView's bulk delete — Undo calls `createTaskMut` to **create a brand-new
row** from a client-side snapshot of the deleted task's core fields
(name/duration/parent/sprint/milestone). The dependency edges, the subtask subtree, the
resource assignments, the task's short_id, its activity history, and its stable UUID are
all lost. The code is honest about it — a `TODO(#2078)` and caveat copy ("Restored the
row only — its subtasks were not recovered") — but the recovery is a lie dressed as an
undo. This is exactly the mislead ADR-0202's project restore (#1113) was built to avoid
one layer up.

The soft-delete substrate needed to fix this already exists and is proven at the project
level. `VersionedModel.restore()` (`models.py:356`) un-tombstones a single row and bumps
`server_version` so the sync pull re-materializes it on the next delta (ADR-0202, no
special-casing). `cascade_project_children_restore()` (`models.py:1446`) + the project
`restore` `@action` (`views.py:1471`) compose that primitive into an atomic, cascade-aware,
broadcast-wired restore. This ADR is the **task-scoped analog of that gold template** —
the design is largely determined; the work is validating the scope rules for a *subtree*
(which, unlike a whole project, is not a closed write-locked world) and wiring the two web
undos to a real endpoint.

**P3M layer:** Programs and Projects — single-project, team-scoped task graph. **OSS.**

## Decision

### 1. Restore cascade scope — faithful inverse of `soft_delete`, scoped to `is_subtask`

Add `cascade_task_children_restore(task)` in `projects/models.py`, the mirror of
`cascade_project_children_restore` but scoped to one task's subtree:

1. **Task first**, then edges (un-tombstoning a task makes it a live endpoint the edge pass
   depends on).
2. **Descendants** — restore `is_deleted=True, is_subtask=True` tasks under
   `wbs_path__startswith=task.wbs_path + "."`. This scope **must match `soft_delete`'s
   `is_subtask=True` filter exactly**. Restoring *all* tombstoned descendants under the
   path (ignoring `is_subtask`) would resurrect WBS-structure children the delete cascade
   never touched — a divergence from the project cascade, which restores every project task
   because the delete cascade *did* tombstone every project task. This is the single point
   where the task cascade is **not** a copy-paste of the project one.
3. **Edges** — restore tombstoned `Dependency` rows whose predecessor *or* successor is in
   the restored set (task + restored descendants), gated on **both endpoints now live**
   (`predecessor__is_deleted=False AND successor__is_deleted=False`) and **no live duplicate**
   on the non-partial `unique_dependency (predecessor, successor, dep_type)` constraint
   (`.exclude(Exists(live_duplicate))`), to avoid `IntegrityError`. An edge to a task
   *outside* the subtree that was never deleted is correctly restored (it was tombstoned
   only because it touched the deleted task, and both ends are now live).
4. **Assignments** need no action — they were never tombstoned and return for free.

All passes use bulk `update(..., server_version=F("server_version") + 1, deleted_version=None,
deleted_at=None)`, the same idiom as the project cascade. Callers MUST run it inside
`transaction.atomic()`.

**"Err toward completeness" holds for a subtree — with a narrower blast radius than the
project case.** Per-row `server_version`/`deleted_version` are counters, not a global clock,
so there is no reliable marker distinguishing "tombstoned by *this* delete cascade" from "the
PM individually deleted this subtask earlier, then deleted the parent." A subtask *can* be
individually deleted via the drawer while its parent is live; restoring the parent then
resurrects that earlier-deleted subtask. This is the **same accepted tradeoff** as the
project precedent (a task individually deleted before the project delete comes back on project
restore) — "half-restore is worse than none." Two facts make it *safer* here than for
projects: (i) the resurrection surface is bounded to one task's `is_subtask` descendants, not
a whole project; (ii) once the parent is tombstoned its subtree is invisible, so no *new*
independent deletion can occur while it sits deleted. Accepted, documented in the helper
docstring.

### 2. Endpoint — `POST /tasks/{id}/restore/` with a trash-inclusive, membership-scoped lookup

Add a `restore` `@action(detail=True, methods=["post"], url_path="restore")` on `TaskViewSet`,
structurally identical to the project restore:

- **Trash-inclusive lookup.** `TaskViewSet`'s class queryset filters `is_deleted=False`, so
  `get_object()` 404s on a tombstoned task. No task-scoped trashed queryset exists yet — build
  a small `_trashed_task_queryset()` helper mirroring `ProjectViewSet._trashed_queryset`:
  membership-scope by project (reuse the `ProjectMembership.filter(user=…, is_deleted=False)`
  → `project_id__in` pattern from `ProjectScopedViewSet`) and filter `is_deleted=True`. This
  keeps the lookup IDOR-safe (never resolves a task in a project the caller isn't a member of)
  while reaching the tombstone. `get_object_or_404(self._trashed_task_queryset(), pk=pk)` then
  `check_object_permissions`.
- **Double-submit → 404 (fail closed).** A second restore of an already-live task no longer
  resolves in the trashed queryset → 404, exactly as project restore. Clients must not rely on
  a 200 for an already-restored id.
- **RBAC = the delete gate, not "Scheduler+".** The established-facts note that task delete is
  "Scheduler+ gated" is **inaccurate** — `TaskViewSet._rbac_permissions` gates
  `update/partial_update/destroy` on **`IsProjectMemberWriteOrOwn`** (Admin+ **or** the task's
  `assignee` FK, ADR-0133 `can_user_edit_task`), *not* `IsProjectScheduler`. Restore mirrors
  delete: add `"restore"` to that same branch so whoever could delete the task can restore it.
  The `Task.assignee` FK persists on the tombstoned row (SET_NULL only fires on a *user* delete),
  so an assignee restore still resolves. **Parity subtlety (rbac-check):** restore is a `POST`,
  but `can_user_edit_task` keys its Product-Owner grooming facet off the would-be verb — a PO may
  edit but **not** delete an EPIC/STORY. Left as `POST`, restore would let a PO un-delete a story
  they couldn't delete. So `IsProjectMemberWriteOrOwn` now passes `method="DELETE"` when
  `view.action == "restore"`, making restore's facet exclusion exactly match delete. MCP
  read-token guards (`mcp_token_guards`) already wrap every action. (`IsProjectNotArchived` is in
  the gate for symmetry with `destroy`, but — like `destroy` — restore is in that permission's
  action-name bypass set, so a task on an archived project can be deleted *and* restored: parity,
  by design.)
- Response: `200 TaskSerializer(task)` (annotated) so the client gets the real restored row back.
- Also add a **`Task.restore()` override** clearing `deleted_at` before `super().restore()`,
  mirroring `Project.restore()` (Task has `deleted_at` but no `deleted_by`, so it clears only
  `deleted_at`). Without it the restored row keeps a stale `deleted_at`. The cascade's bulk
  update already clears `deleted_at` for descendants/edges; this covers the single top row.

### 3. Bulk restore (GridView undo) — fan out `POST /tasks/{id}/restore/` per id

**Decision: GridView's bulk-undo calls the single restore endpoint once per id** (a
`useBulkRestoreTasks` hook does `Promise.all(ids.map(restore))`). This is what #2078's text asks
for — the bulk undo "backed by **the same endpoint**" — and it keeps the change to the single,
well-contained endpoint rather than opening surgery on the hot, intricate `TaskBulkView` write
path (its up-front `select_for_update` prefetch filters `is_deleted=False`, so a restore op would
need a second trashed-lookup + lock branch threaded through a 200-line method — real risk for
little gain at this batch's scale).

The two downsides are bounded: (i) N `_enqueue_recalculate` calls — but recalc is **already
server-side coalesced**, so a burst collapses to one recompute; (ii) N `task_restored` broadcasts
— each just invalidates the web tasks query, which TanStack Query dedupes. Idempotency and
ordering are non-issues: restoring a parent cascades its `is_subtask` children, and a later
per-id restore of an already-live child 404s (harmless — the client ignores it) or no-ops.

**Rejected alternative — `{op: "restore"}` on `TaskBulkView`:** truer batch atomicity (one
transaction, one recalc, one `tasks_bulk_mutated`), but requires a second trashed lock/lookup
path and a third op branch in the hot bulk method. Deferred as a future optimization if bulk
undo ever operates at a scale where the coalesced-but-repeated recalc dispatch matters; not worth
the write-path risk now, and the issue explicitly points at "the same endpoint".

### 4. Broadcast / recalc / webhooks — mirror delete, all `on_commit`

The single-task `restore` action, after the atomic block:
- `transaction.on_commit(_enqueue_recalculate(project_id))` — restoring a task (and its edges)
  changes the CPM graph; recompute. Via the existing `scheduling/services` seam, never
  `.delay()` directly.
- `transaction.on_commit(broadcast_board_event(project_id, "task_restored", {"id": task_id}))`
  — a **new WS event**, mirroring the existing `project_restored`. Requires: (i) adding
  `"task_restored"` to `FROZEN_WS_EVENT_TYPES` (`test_broadcast.py`, the #1019 freeze guard);
  (ii) a web dispatch-table handler in `useProjectWebSocket.ts` that invalidates the tasks query
  (same shape as `task_created`/`task_deleted`). Cheap, symmetric with the project precedent.
- **No `task.restored` webhook** — see below.

The bulk path keeps its existing `tasks_bulk_mutated` broadcast + single recalc; it does **not**
emit `task_restored` (bulk mutations never emit the per-row events).

**Webhook `task.restored` — deliberately omitted (scoped out).** The OSS catalog is at exactly
`OSS_WEBHOOK_EVENT_CAP = 19` (`webhooks/models.py`, 19/19), and ADR-0083 gates a 20th event
behind its own ADR + a `test_event_type_cap` bump. **Decision: do NOT add the webhook in this
change.** Reasons: (i) it is out of #2078's stated scope — the issue asks for the endpoint, the
**WS broadcast**, sync-version bumps, and the two web undos, not a webhook; (ii) the in-app undo
is already fully faithful via the `task_restored` WS event + recalc; (iii) adding it consumes the
**last** OSS cap slot and amends a governance ADR, which deserves an explicit sign-off rather than
riding in on a feature MR. The **known limitation**: an external integration that deleted its
mirror on `task.deleted` gets no signal to re-create it after an undo, so its mirror stays
divergent until the next `task.updated`/full resync. Closing that gap is a one-line follow-up
(add `TASK_RESTORED`, bump the cap to 20, update `test_event_type_cap`) gated on the cap
governance decision — tracked for a future, deliberate call. (Rejected alternative for *this* MR:
carry the cap bump here — rejected as an unauthorized governance commitment bundled into a feature.)

### 5. Sync correctness — `server_version` bump on every restored row

Confirmed. The offline pull (ADR-0202) buckets rows into updated vs deleted purely on current
`is_deleted`, gated by `server_version__gt=since`. Every restored row (top task, descendants,
edges) must bump `server_version` so it re-materializes on the client's next delta. The bulk
`update(server_version=F("server_version") + 1, is_deleted=False, deleted_version=None,
deleted_at=None)` shape from the project cascade is the correct idiom — within one UPDATE each
`F()` reads the pre-update column, so `server_version` and the cleared markers resolve together.
The single top task uses `Task.restore()` (a `save()`), which bumps `server_version` the same way.

### 6. Migration — none

Confirmed. No schema change: the feature reuses `is_deleted` / `deleted_version` / `deleted_at`
/ `server_version`, all existing. The only model-code change is the `Task.restore()` override and
the new module-level cascade function — behavior, not schema. `makemigrations --check` stays green.
(The webhook cap is a Python constant + a `TextChoices` member — no DB migration; `event_type` is
already a free-text/choices field sized for it.)

### 7. Web wiring

- **New hook `useRestoreTask(projectId)`** in `useTaskMutations.ts`: `POST /tasks/{id}/restore/`,
  returns the mapped task, `onSuccess` invalidates `['tasks', projectId]` and the restored task's
  `['task-history', projectId, id]` (mirror `useDeleteTask`). Model on the existing
  `useRestoreResource` / `useRestoreProject` hooks.
- **ScheduleView single-undo**: replace the `createTaskMut` call in `performBuildModeDelete` with
  `restoreTaskMut.mutate(taskId)`. Drop the `descendantCount > 0` caveat branch — the restore is
  now faithful, so the toast is a flat **"Restored"** (re-`focusRow` the *same* id, not a
  recreated one). Delete the `TODO(#2078)` and the "subtasks were not recovered" copy.
- **GridView bulk-undo (new)**: the delete toast (`GridView.tsx:239`) currently offers no undo —
  add an "Undo" action that calls a **`useBulkRestoreTasks(projectId)`** hook posting
  `operations: ids.map(id => ({op: "restore", id}))` to the bulk endpoint, with a "Restored N
  tasks" confirmation toast on success and an error toast on failure.
- Tests (three-layer, same MR): pytest for the endpoint (happy path, subtree+edge restore, double-
  submit 404, RBAC Admin+/assignee, IDOR foreign-project 404, bulk restore op); vitest for
  `useRestoreTask`/`useBulkRestoreTasks`; Playwright for both undo golden paths (delete → Undo →
  row + its subtasks/deps reappear).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Create-a-new-row Undo (status quo)** | Zero backend work; already shipped | Loses subtree, edges, assignments, short_id, history, and the stable UUID; the "undo" is a fabrication (#2029 flagged the mislead). Rejected — it is the bug. |
| **Faithful `restore` endpoint + subtree cascade (chosen)** | Reuses the proven project-restore substrate; atomic; sync-correct; honest undo; no governance-gated resource consumed | Requires a task-scoped trashed queryset and a WS-freeze entry. Leaves external webhook mirrors divergent after an undo (accepted; §4). |
| Per-operation "deleted-by-this-cascade" marker (e.g. a delete-batch id stamped on every tombstoned row) to make restore *exact* rather than *complete* | Would avoid resurrecting an independently pre-deleted subtask | Rejected — same reasoning as ADR-0202: `server_version`/`deleted_version` are per-row counters with no batch identity; adding a batch-id column is a schema change + migration + write-path cost to eliminate a bounded, low-harm over-restore that "err toward completeness" already accepts one layer up. Not worth it for an `is_subtask` subtree. |
| Restore **all** `is_deleted` descendants under `wbs_path` (ignore `is_subtask`) | One-line simpler cascade | Rejected — diverges from `soft_delete`'s `is_subtask=True` scope; would resurrect WBS-structure children the delete never tombstoned. |
| Bulk-undo via N single-endpoint calls **(chosen)** | No `TaskBulkView` surgery; matches the issue's "same endpoint"; recalc coalesces server-side | N broadcasts (deduped by the web query cache); no single-transaction atomicity across the batch. Accepted at this scale. |
| `{op:"restore"}` on `TaskBulkView` | One transaction / one recalc / one `tasks_bulk_mutated` | Rejected for now — a third op branch + a second trashed lock/lookup on the hot bulk write path; real risk for little gain. Deferred as a future optimization. |
| Omit the `task.restored` webhook to preserve the cap slot **(chosen for this MR)** | Stays 19/19; no unauthorized ADR-0083 amendment bundled into a feature; in-app undo still fully faithful (WS + recalc) | External webhook mirrors stay divergent after an undo until a later, deliberate cap bump. Accepted as a scoped, low-harm limitation with a one-line follow-up path. |

## Consequences

- **Easier:** Undo on ScheduleView and GridView becomes truthful — the full task graph
  (subtree + dependency edges + assignments + identity + history) comes back. The pattern is now
  available for any future task-Trash UI (a "recently deleted tasks" list would drop straight onto
  the endpoint).
- **Harder / cost:** One frozen contract moves by one entry — `FROZEN_WS_EVENT_TYPES`
  (+`task_restored`) — with its guard test updated in the same MR. No change to the hot
  `TaskBulkView` path (bulk undo fans out to the single endpoint — §3).
- **Risks:** (1) The bounded over-restore of an independently pre-deleted subtask — accepted and
  documented, matching ADR-0202. (2) External webhook mirrors stay divergent after an undo (no
  `task.restored` — deliberately scoped out; §4) until a later, governance-gated cap bump. (3) The
  subtree edge pass must not IntegrityError on the non-partial unique constraint — mitigated by the
  `.exclude(Exists(...))` live-duplicate guard copied verbatim from the project cascade.

## Implementation Notes
- **P3M layer:** Programs and Projects.
- **Affected packages:** api (`projects/models.py`, `projects/views.py`),
  web (`useTaskMutations.ts`, `ScheduleView.tsx`, `GridView.tsx`,
  `useProjectWebSocket.ts`), plus the guard test (`test_broadcast.py`).
- **Migration required:** no.
- **API changes:** yes — `POST /tasks/{id}/restore/` (new `@action`); new `task_restored` WS
  board event. Bulk undo reuses the single endpoint (no `TaskBulkView` change — §3). **No** new
  webhook event (deliberately scoped out — §4).
- **OSS or Enterprise:** OSS.

### Durable Execution
1. **Broker down at dispatch:** Both side effects (recalc, WS broadcast) are deferred via
   `transaction.on_commit` and dispatched through the **existing** outbox-backed seam
   (`_enqueue_recalculate` → `scheduling/services`). No new direct `.delay()` at the view layer.
   A broker outage is re-dispatched by the existing schedule drain, identical to the delete path
   this mirrors. (No webhook side effect — §4.)
2. **Drain task:** None new — reuses the existing schedule-recalculation drain and the webhook
   outbox drain. Restore introduces no new *category* of async work; its dispatch semantics match
   delete's exactly.
3. **Orphan window:** N/A for new infrastructure — the reused webhook/schedule drains keep their
   existing orphan-window thresholds (5 min webhooks / 10 min schedule).
4. **Service layer:** `scheduling/services` (via `_enqueue_recalculate`) for CPM; the existing
   `_dispatch_webhooks` helper for webhooks. New domain function needed: module-level
   `cascade_task_children_restore(task)` in `projects/models.py` (the pure-DB cascade, no async).
5. **API response on best-effort dispatch:** Synchronous `200 TaskSerializer(task)` — the DB
   restore is synchronous and authoritative; the async side effects (recalc/broadcast/webhook)
   are fire-and-forget post-commit, so no `{"queued": true}` is warranted. Matches project restore.
6. **Outbox cleanup:** N/A new — reuses the existing webhook/schedule outbox purge schedules.
7. **Idempotency:** Three layers. (i) The cascade filters `is_deleted=True` on every pass, so a
   re-run touches only still-tombstoned rows and bumps no versions — a safe no-op. (ii) A second
   *HTTP* restore of an already-live task 404s (trash-inclusive lookup no longer resolves it) —
   fail-closed, never a double-apply. (iii) `ProjectScopedViewSet`/`TaskBulkView` honor the
   `Idempotency-Key` header (ADR-0170) so a network-retried POST collapses to one effect.
8. **Dead-letter / failure handling:** Inherited from the reused seams — the webhook outbox's
   existing retry-limit/DLQ and the schedule drain's existing retry policy apply unchanged. A
   failure *inside* the atomic restore (e.g. an unexpected IntegrityError) rolls the whole restore
   back (all-or-nothing), leaving the task tombstoned and the client's Undo reporting an error
   toast — no half-restored graph.
