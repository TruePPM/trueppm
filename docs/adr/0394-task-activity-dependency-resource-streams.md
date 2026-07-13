# ADR-0394: Task-activity feed — dependency and resource-assignment streams, and actor-visibility policy

## Status
Accepted

## Context
The task-drawer activity feed (`GET /projects/{id}/tasks/{id}/history/?include=…`,
issue #413, ADR-0207, #1604) merges opt-in per-task event streams into one
timestamp-desc feed. Today `_ACTIVITY_SOURCES = {comments, time, attachments,
schedule, risks}`. A 2026-07-13 audit of task activity found three gaps:

- **#1887** — Adding or removing a **dependency** (the single most schedule-impacting
  task change) appears in neither linked task's feed. `Dependency` *is* history-tracked
  (`HistoricalDependency`), so the data exists; there is simply no stream reading it.
- **#1886** — Multi-resource assignments (`TaskResource`) are never recorded. Unlike
  the legacy single `Task.assignee` FK, `TaskResource` is a plain `models.Model` with
  no `HistoricalRecords`, and `TaskResourceViewSet` writes no activity row. Adding,
  removing, or re-allocating a resource is invisible in the feed.
- **#1881** — Policy conflict: `TaskHistoryView` returns `history_user` (the actor) to
  **every** project member, but ADR-0032 said this endpoint should hide the actor below
  Admin. ADR-0160, however, deliberately shows the board-activity actor to all members.
  Two conflicting policies; the endpoint follows neither deliberately.

P3M layer: **Programs and Projects / Operations** (single project, task-scoped audit
surface). OSS — a PM/team needs task history to run their program.

## Decision

### #1887 — `dependencies` stream (read from history)
Add a `dependencies` include token. Its stream reads `HistoricalDependency`
(`Dependency.history.model`) for edges where `predecessor_id == task` OR
`successor_id == task`, and emits:
- `dependency_added` — from each `+` (create) row, and from a `~` row where
  `is_deleted` transitions `True → False` (restore).
- `dependency_removed` — from a `~` row where `is_deleted` transitions `False → True`
  (soft-delete; `Dependency.soft_delete()` writes a `~` row, never a `-` row).

Actor is `history_user` (populated automatically by `HistoryRequestMiddleware`; null
for programmatic writes). No migration — the historical table already exists.
Ordering/paging is on `history_date` (indexed), consistent with the field-diff feed.

**Cross-project disclosure guard (ADR-0120).** An edge's far endpoint can live in a
project the caller is not a member of, and `TaskHistoryView` authorizes only the
*current* task's project. The far task's **name** is therefore resolved and rendered
only when the far task's project is one the caller belongs to; otherwise the event
carries `other_task_name: null` (direction + dep_type still shown). This closes the
IDOR/title-leak vector the naive `_history_fk_label(other_task)` would open.

### #1886 — `resources` stream (TaskActivityEvent, ADR-0207 precedent)
`TaskResource` is the same shape as `RiskTask` (a through-table with no history), so it
follows the identical ADR-0207 pattern rather than growing a historical table. Add
three `TaskActivityEventType` members — `assignee_added`, `assignee_removed`,
`assignee_units_changed` (all ≤ 32 chars) — and write one `TaskActivityEvent` row
**synchronously inside the request transaction** from `TaskResourceViewSet`
`perform_create` / `perform_update` / `perform_destroy`, exactly as
`_record_risk_link_events` does (so the audit row commits or rolls back with the
assignment itself — it is a DB row, not an external side effect, so it does **not** go
in the `on_commit` board-broadcast closure). `perform_update` compares the pre-save
resource FK and units: a resource re-point emits `assignee_removed(old) +
assignee_added(new)`; a units-only change emits `assignee_units_changed`. Add a
`resources` include token filtering these three event types, mirroring `risks`.

### #1881 — actor visible to all members (option a)
Align ADR-0032 to ADR-0160: the per-task activity feed shows the actor to **all**
project members. `TaskHistoryView` already behaves this way, so there is **no behavior
change** — the decision is recorded here, ADR-0032 is annotated, and a regression test
is added exercising a **populated** `history_user` seen by a Viewer (the existing
`test_viewer_sees_null_history_user` only covers a null author and gives false
confidence). `apps/history/views.py::_caller_can_see_user` — which governs the separate
project-level history surfaces under ADR-0201's anti-surveillance rule — is **not**
touched.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| #1886 via `TaskActivityEvent` (chosen) | Follows ADR-0207/RiskTask precedent exactly; no new historical table; localized to the viewset; captures re-point + units | Two writes per re-point; not synced to mobile (acceptable — audit rows never are) |
| #1886 via `HistoricalRecords` on `TaskResource` | Symmetric with #1887's read-from-history | New historical table + migration; `TaskResource` is not a VersionedModel; over-engineered for an audit-only need; diverges from the RiskTask precedent |
| #1881 (b) Admin+ gate here | Stricter anti-surveillance | Members/Viewers see actorless "System" rows; needs a web null-actor treatment; contradicts ADR-0160 board-feed precedent; product owner chose (a) |

## Consequences
- **Easier**: dependency and assignment changes are now first-class in the merged feed;
  the #1883 frontend can adopt all five new event types with no further backend work.
- **Harder**: `_build_activity_events` grows two more streams (still independently
  capped and `until`-bounded); the event-type vocabulary is now seven strings.
- **Risks**: cross-project label leak (mitigated by the membership guard above);
  choices migration must merge cleanly against sibling worktrees (see Implementation
  Notes). A resource re-point produces two events — intended, mirrors add/remove.

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: **api** only (web is the separate #1883 follow-up)
- Migration required: **yes** — one `AlterField` on `TaskActivityEvent.event_type`
  choices (projects app). Generated via `makemigrations`, not hand-edited. Sequencing:
  ~12 sibling worktrees are in flight; if a leaf-node conflict arises at merge, resolve
  with `makemigrations --merge` (the choices change is additive and commutative). The
  `api:migration-check` gate proves the committed migration matches the model.
- API changes: **yes** — two new `include` tokens (`dependencies`, `resources`) and
  five new `event_type` values in the merged feed; the bare field-diff feed is
  unchanged (byte-identical). OpenAPI regenerated.
- OSS or Enterprise: **OSS** (`trueppm-suite`).

### Durable Execution
1. Broker-down behaviour: **N/A** — the two read streams are pure reads; the
   `TaskActivityEvent` writes are synchronous DB rows inside the assignment's request
   transaction (ADR-0207 precedent), not a queued task. No new dispatch path. The
   existing CPM enqueue and board broadcast in `TaskResourceViewSet` are unchanged.
2. Drain task: **N/A** — no new async work.
3. Orphan window: **N/A** — no `on_commit`-deferred rows added.
4. Service layer: reuses `scheduling/services.py::enqueue_recalculate` (unchanged).
   `TaskActivityEvent` rows are constructed directly, matching `_record_risk_link_events`
   (no shared emit service exists and none is warranted for three call sites).
5. API response on best-effort dispatch: **N/A** — assignment endpoint response shapes
   are unchanged; no async dispatch introduced.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: read streams are pure reads. Each assignment mutation writes exactly one
   audit row (or two on re-point) inside its own transaction; a retried HTTP request is a
   distinct mutation and *should* produce a distinct event — no dedup key needed.
8. Dead-letter / failure handling: the audit-row write shares the assignment
   transaction — on failure the assignment rolls back with it (consistent with the risk
   precedent). No DLQ; nothing to re-trigger.
