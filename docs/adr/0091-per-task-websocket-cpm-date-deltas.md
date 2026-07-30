# ADR-0091: Per-Task WebSocket CPM Date Deltas

## Status
Accepted (2026-05-27)

## Context
When a user edits a dependency or reschedules a task, the CPM recalculation
(`recalculate_schedule`) runs asynchronously and `bulk_update`s the computed date
fields (`early_start`, `early_finish`, `late_start`, `late_finish`, `total_float`,
`free_float`, `is_critical`) on every affected task. The originating client now sees
the cascade quickly (#314), but **collaborators** only learn that "something changed"
via the coarse `task_run_completed` / `cpm_complete` broadcast (ADR-0020), which
carries only `project_finish` + `critical_path`. The frontend reacts by invalidating
the entire `['tasks', projectId]` query and re-fetching every page — a slow, heavy
refresh just to move a handful of bars.

This ADR defines a per-task delta event so a collaborator's Gantt bar slides the moment
the originator's CPM run completes, with no full re-fetch.

The CPM `bulk_update` **deliberately bypasses `VersionedModel.save()`**, so
`server_version` is *not* bumped for CPM-output fields (`scheduling/tasks.py`). This is
an intentional carve-out: mobile clients re-derive CPM locally from the same scheduler
engine rather than receiving a flood of sync deltas on every recompute. Any real-time
delta mechanism must preserve this carve-out — it is an **optimization layer over** the
sync protocol (ADR-0082), not a replacement for it.

**P3M layer:** Programs and Projects (single-project schedule). OSS.

## Decision

### 1. New best-effort WebSocket event `task_dates_updated`
Emitted once at the end of `_run_schedule`, immediately after the `bulk_update` commits,
from the same point that broadcasts `cpm_complete` today. It is built from the
`tasks_to_update` list already in scope (Django instances whose CPM fields are mutated
in-memory), so it costs no extra query. *(Superseded by the amendment below — the
payload is built from the moved subset of that list, still with no extra query.)*

Broadcast via the existing `broadcast_board_event(project_id, "task_dates_updated", payload)`
on the `project_{pk}` channel group. Event name uses the snake_case `task_*` family
convention already in the codebase (the issue's literal `task.dates_updated` is renamed
to `task_dates_updated` for consistency with `task_created` / `task_updated`).

**Payload (delta case, changed-set size ≤ `CPM_DELTA_BROADCAST_CAP`):**
```json
{
  "count": 3,
  "tasks": [
    {
      "id": "<uuid>",
      "early_start": "2026-06-01",
      "early_finish": "2026-06-05",
      "late_start": "2026-06-03",
      "late_finish": "2026-06-07",
      "total_float": 2,
      "free_float": 1,
      "is_critical": false,
      "planned_start": "2026-06-01",
      "duration": 5
    }
  ]
}
```
Field names match `SyncTaskSerializer` / the DRF `TaskSerializer` exactly (ADR-0082), so a
client can splice them into a cached task without renaming, and a future mobile client
*could* splice them too. `planned_start` and `duration` are included (ADR-0014) so the
receiver can position and size the bar correctly without a round-trip; `early_start` etc.
remain server-owned and read-only.

**Payload (truncated case, changed-set size > cap):**
```json
{ "count": 1287, "truncated": true }
```
No task array. The client falls back to invalidating `['tasks', projectId]`. This bounds
the WS frame size on large/full recomputes. `CPM_DELTA_BROADCAST_CAP = 500` (a 500-task
payload is ≈60 KB; above that the re-fetch is cheaper and simpler than a giant frame).
*(The ≈60 KB estimate was low — a delta row serializes to ≈264 bytes, so 500 rows is
≈130 KB. Corrected in the amendment below; the cap value itself is unchanged.)*
The incremental-CPM path (ADR-0027) already restricts the written set to the affected
subgraph, so the truncated path is reached only on genuine large/full recomputes — the
same situation that triggers a full re-fetch today. *(This premise was false in
practice — see the amendment below.)*

### 2. Client ownership of the tasks cache moves to the delta event
The `task_dates_updated` handler in `useProjectWebSocket` becomes the **sole** maintainer
of CPM freshness in the `['tasks', projectId]` cache:
- **delta case** → `setQueryData<Task[]>` splices each delta into the matching cached task
  (via the shared `deriveBarGeometry` rules, so the result is byte-for-byte a re-fetch).
  **No invalidation** — the full re-fetch is eliminated, which is the acceptance criterion.
  In v1 the canvas repaints through the existing tasks-query → `engine.setTasks` sync (a
  full repaint, same as `main` paid on every `cpm_complete`); the dirty-rect optimization
  via `engine.updateTask` envisioned here is tracked as a follow-up (#795) since it
  requires the engine ref in the WS layer.
- **truncated case** → `scheduleInvalidate('tasks')` (the existing 300 ms-debounced path).

Correspondingly, the `task_run_completed` and `cpm_complete` handlers **stop** calling
`scheduleInvalidate('tasks')`. They keep their other responsibilities: `setCpmComplete(project_finish)`
for the status pill and the `shellStats` invalidation. Task-date freshness is now owned by
`task_dates_updated`, so the redundant full re-fetch is eliminated — satisfying the
acceptance criterion.

### 3. Mobile is unchanged — the carve-out is preserved
The event is **advisory for web**. Mobile clients continue to re-derive CPM locally on
`task_run_completed` exactly as today; they MAY ignore `task_dates_updated`. Because
`bulk_update` still bypasses `server_version`, no sync delta is generated and the next
pull (ADR-0082) does not carry these fields as changes — there is no divergence. The
field names match `SyncTaskSerializer` deliberately so a later mobile release can opt into
splicing without a protocol change, but v1 mobile behavior is untouched.

### 4. Polling is already correct
Fallback polling (`useScheduleTasks`) is already disabled while the socket is `live` and
only runs at 30 s when the socket is down. No change is needed; the delta event simply
makes the live path richer.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. Per-task delta event + client splice (chosen)** | Instant collaborator feedback; no full re-fetch; reuses existing broadcast + `engine.updateTask`; field-name parity with sync | Adds a payload-shape contract; rolling-deploy ordering (backend first) |
| B. Keep coarse `cpm_complete` invalidate only | Zero new code | Full multi-page re-fetch on every cascade; the problem #315 exists to fix |
| C. Bump `server_version` on CPM writes so deltas flow through the normal sync pull | One code path for web + mobile | Breaks the deliberate carve-out; floods mobile with re-derivable deltas; far higher write cost |
| D. One WS event **per task** (not batched) | Simplest payload | N frames per cascade; fanout storm on large recomputes; defeats the batching the issue asks for |

## Consequences
- **Easier:** Collaborators see cascades in real time; the Schedule view stops doing a full
  re-fetch on every remote CPM run; the splice path is reused for any future single-task
  remote update.
- **Harder:** There is now a payload-shape contract between `_run_schedule` and the WS
  handler — adding a CPM-output field means updating both ends (covered by tests).
- **Risk — rolling deploy:** A new frontend talking to an *old* backend (no
  `task_dates_updated`) would not refresh task dates after CPM, because the new frontend
  no longer invalidates on `task_run_completed`. Mitigation: deploy backend before
  frontend (standard ordering); and any subsequent `task_created` / `task_updated` event,
  window refocus, or reconnect still triggers a TanStack refetch. Acceptable for alpha.
- **Risk — dropped event:** Best-effort, like `cpm_complete`. If the frame is lost, the DB
  is still authoritative (the `bulk_update` committed); web reconciles on the next
  refetch / reconnect / subsequent CPM run, and mobile re-derives regardless. No
  correctness loss, only a delayed visual update in the rare drop case.
- The `['dependencies', projectId]` cache is a separate key and is **not** touched by this
  event (ADR-0066) — task-date splicing does not affect the dependency adjacency map.

## Implementation Notes
- P3M layer: Programs and Projects. OSS.
- Affected packages: api (`scheduling/tasks.py`), web (`useProjectWebSocket.ts`,
  `useScheduleTasks.ts`).
- Migration required: no (no model changes; CPM fields already exist).
- API changes: no new HTTP endpoint. One new WebSocket event type, `task_dates_updated`.
- OSS or Enterprise: OSS.

### Durable Execution
1. **Broker-down behaviour:** N/A for the broadcast. It is a best-effort WS event emitted
   from *inside* the already-dispatched CPM task, after the `bulk_update` has committed.
   The durability of CPM *dispatch* is unchanged — it still flows through
   `services.enqueue_recalculate()` and the `ScheduleRequest` outbox (ADR-0027). No new
   dispatch path is introduced. If the channel layer (Redis) is down, the frame is lost
   and clients reconcile via refetch/re-derive.
2. **Drain task:** None. The event is fire-and-forget after the durable CPM pass; it
   reuses no drain and needs none.
3. **Orphan window:** N/A — no outbox row is created for the broadcast.
4. **Service layer:** CPM continues to go through `scheduling/services.py::enqueue_recalculate()`.
   The broadcast uses the existing `sync/broadcast.py::broadcast_board_event()` helper. No
   new service function.
5. **API response on best-effort dispatch:** N/A — no new endpoint. The trigger remains the
   existing `PATCH /tasks/{id}/` → `enqueue_recalculate` (already returns the standard task
   response; CPM is outbox-queued).
6. **Outbox cleanup:** N/A — no outbox row.
7. **Idempotency:** The event is derived purely from committed DB state. Re-running the CPM
   task re-emits an identical payload, and a duplicate delivery splices identical values —
   the splice is idempotent (`setQueryData` overwrites the same fields; `engine.updateTask`
   is a positional patch). No dedup key required.
8. **Dead-letter / failure handling:** None. A failed broadcast is swallowed (best-effort,
   identical tier to `cpm_complete`). Justified: the DB is the source of truth and all
   clients have an independent reconciliation path (web refetch, mobile re-derive), so a
   lost frame degrades only latency, never correctness.

## Amendment (2026-07-30, #2573) — the changed set is derived in-process

The payload contract above is unchanged. What changed is where the *changed set*
comes from.

This ADR specified the payload in terms of the changed set ("delta case, changed-set
size ≤ cap"), and the truncated-case rationale above assumed ADR-0027's incremental
CPM would supply that set by restricting the written set to the affected subgraph.
ADR-0027 has not landed. In its absence the implementation shipped
`tasks_to_update` — the *full* write-back set — and because a CPM pass re-assigns
every engine-returned row whether or not its value moved, the changed set was
effectively the whole project. Every project above `CPM_DELTA_BROADCAST_CAP`
therefore broadcast `truncated: true` on every recalculation, each connected client
re-fetched the whole paginated task list, and decision §2's splice path was
unreachable at the documented envelope — the exact full-re-fetch cost this ADR
exists to remove.

Until ADR-0027 lands, the changed set is derived in-process instead:
`_apply_cpm_results` snapshots each row's CPM-owned fields before overwriting them
and returns a `moved_tasks` subset of rows whose snapshot changed. That subset is
what `_member_cpm_delta` ships, in both the single-project and program-pass paths,
so `count` means moved-task count in both the delta and truncated branches as
specified above.

`tasks_to_update` keeps its original meaning and stays the full set — it drives the
`bulk_update` write-back and the ADR-0207 schedule-shift activity events, both of
which must still see every row. The cap and its `truncated` fallback are retained
unchanged, now sized against the moved set, so they fire only when the recalc genuinely
moved that many rows — a first-ever pass, a calendar change, a project-start shift, or
any edit that shifts the project finish (see the residual case below).

The diffed field set is exactly the set the write-back persists (`early_start`,
`early_finish`, `late_start`, `late_finish`, `total_float`, `free_float`,
`is_critical`, `duration`). `planned_start` also rides in the payload but is a
user-owned field the CPM write-back never touches, so it cannot make a row moved; a
user edit to it arrives on `task_updated`.

When ADR-0027 lands, this derivation becomes redundant rather than wrong — the
engine would already return only the affected subgraph, and the diff would simply
find every returned row moved.

Two measurements above were also corrected while verifying this:

- **Payload size.** A delta row serializes to ≈264 bytes (UUID + four ISO dates + two
  ints + a bool + `planned_start` + `duration`), so the 500-row cap is ≈130 KB rather
  than the ≈60 KB estimated here. The cap value is left at 500 — the original figure
  was an estimate, not a budget — but the number is now stated correctly so a future
  re-sizing argues from the real one.
- **Residual truncation case (#2598).** The backward pass seeds every task's
  late-finish constraint from the project finish, so any edit that shifts the project
  finish shifts `late_start` / `late_finish` / `total_float` across the whole network.
  Those fields are in the payload, so a **critical-path edit still truncates** on a
  large project even though almost no bars move (measured: 2,000 of 2,000 rows moved,
  10 of them early dates). Splitting bar-moving fields from late/float re-anchoring is
  tracked in #2598; it is a narrowing of this ADR's cost model, not a change to the
  payload contract.

### Consequence of the narrowing: frames no longer self-repair

Worth stating explicitly, because it is the one property the narrowing gives up.
Under the old (full write-back set) behavior every frame carried the whole project,
so a client that missed frame N was fully repaired by frame N+1. A narrowed frame
carries only what moved in *its* pass, so recovery now depends on ADR-0236 replay
rather than on the next frame happening to be a superset.

That is a sound trade — replay is wired for this event (`task_dates_updated` is not
in `DONT_PERSIST_EVENT_TYPES`, and the client seq-gate rejects out-of-order splices)
— but it has one residual hole: `_persist_board_event` swallows a `DatabaseError`
and still emits the live frame with `seq: null` and no replay row. Because no seq is
consumed, a client's `since` cursor stays inside the buffer and no `resync_required`
fires, so a DB failure *plus* a missed live frame can leave a client silently stale
until its next refetch, reconnect, or CPM run. Accepted: it needs two independent
failures, and every affected value is re-derivable from the API.
