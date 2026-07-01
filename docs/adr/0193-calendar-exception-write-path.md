# ADR-0193: Calendar Exception Write Path — Nested CRUD, Aggregate-Root Sync, and Calendar-Change Recompute

## Status
Accepted

## Context

`CalendarException` rows (holidays, shutdowns — non-working date ranges within a
`Calendar`) can only be created via the ORM or seed today. The 2026-06-10 product
audit (§4.5, issue #1079) confirmed the gap is real and worse than suspected:

- `CalendarSerializer` (`apps/projects/serializers.py`) nests exceptions **read-only**
  and its docstring promises "exceptions are managed through the
  `/calendars/{pk}/exceptions/` sub-resource" — **that route does not exist** (no
  entry in `projects/urls.py`, no view anywhere; `drf-nested-routers` is not
  installed).
- `SyncCalendarSerializer` (`apps/sync/serializers.py`) docstring says exceptions
  are "synced separately via SyncView" — **also not implemented**. Offline clients
  therefore never receive holiday ranges, so any project with holidays computes the
  wrong CPM offline.

Working-time data is a first-class CPM input — lag is calendar-aware — so this is an
API-first violation (CLAUDE.md Key Design Principle 1): a UI or MCP client cannot
manage non-working days at all.

**P3M layer:** Programs and Projects / Operations — `Calendar` is an OSS org-level
shared resource (ADR-0033). This is not cross-program or portfolio scope; it stays OSS.

## Decision

1. **Nested CRUD via explicit `path()` + a dedicated viewset.** Add
   `CalendarExceptionViewSet` mounted at `/calendars/{calendar_pk}/exceptions/`
   (list + create) and `/calendars/{calendar_pk}/exceptions/{pk}/` (retrieve, update,
   partial_update, destroy). We do **not** add `drf-nested-routers`, and we do **not**
   use an `@action` with a regex `url_path` — the codebase deliberately avoids that
   after the ghost-route/OpenAPI-pollution problem (#846). The viewset does **not**
   inherit `ProjectScopedViewSet`, because calendars are org-level, not project-scoped;
   it mirrors `CalendarViewSet`'s gate directly.

2. **Permissions mirror `CalendarViewSet` (ADR-0034).** Read = `IsAuthenticated`
   (calendars appear in resource/roster pickers any member needs); write =
   `IsAuthenticated + IsOrgAdmin` (Project Manager / `Role.ADMIN`+ on at least one
   project). The parent `calendar` is taken from the URL, never the request body, so
   an exception cannot be reparented to another calendar by a crafted payload (IDOR).

3. **Sync: exceptions ride the aggregate root, they do not join the sync union.**
   `CalendarException` stays a plain `models.Model` (no `server_version`, no
   `is_deleted`). On every exception write we bump the parent `Calendar.server_version`
   (a normal `VersionedModel.save()`), and `SyncCalendarSerializer` now nests the full
   exceptions list (read-only). Offline clients receive holiday/shutdown ranges through
   the **existing** calendar delta and re-derive CPM locally. This follows the
   `TaskNote`/`ForecastSnapshot` precedent (ADR-0143, ADR-0154): a sub-resource with no
   mobile-*edit* use case is not promoted into the 12-table sync union (ADR-0142),
   which would demand a serializer + `ProjectSyncView` queryset + watermark receiver +
   a conformance test. Because the client replaces the whole nested list on each
   calendar delta, **hard delete is safe** — no tombstone is required.

4. **Any calendar-definition change forces a full CPM recompute for every live project
   using that calendar (ADR-0027, ADR-0034).** `ProjectViewSet.perform_update` already
   recomputes when a project *swaps* calendars (#1267), but nothing recomputes when the
   calendar's own working-day mask, hours/day, or exception ranges change — a latent gap
   (the `ScheduleRequestReason.CALENDAR_CHANGE` enum was added for exactly this but was
   unused). A shared `_recalc_projects_for_calendar(calendar_id)` helper enumerates
   `Project.objects.filter(calendar_id=…, is_deleted=False)` and enqueues one coalesced
   `enqueue_recalculate(pid, reason=CALENDAR_CHANGE)` per project inside
   `transaction.on_commit`, exactly like the org-level `Resource`-deactivation fan-out
   (ADR-0034). It is wired into both `CalendarExceptionViewSet` writes **and**
   `CalendarViewSet.perform_update`, closing the gap consistently. `changed_task_ids` is
   not narrowed — a calendar change can move any task, so a whole-project recompute is
   the correct default (ADR-0027 "bulk import" row).

5. **Validation:** `exc_end >= exc_start` (400 otherwise; partial updates validate the
   changed endpoint against the stored one). Overlapping ranges within a calendar are
   allowed — merging is a client concern and overlaps are harmless to `is_working_day`.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Sync B — aggregate-root (**chosen**): bump parent `Calendar.server_version`, nest exceptions in the calendar delta | No migration; no new sync collection; no tombstones; fixes the latent offline-CPM bug; matches ADR-0143/0154 | Whole exceptions list re-sent on each calendar delta (fine — small, low-churn) |
| Sync A — make `CalendarException` a `VersionedModel` with its own sync collection | Per-row deltas; independent soft-delete | Migration + backfill; a new sync-union member (ADR-0142 3-wiring + conformance test) for a consumer that does not exist yet |
| `@action(url_path="exceptions/(?P<exc_pk>…)")` on `CalendarViewSet` | No new class | Ghost parameterless route + OpenAPI pollution (#846), explicitly avoided |
| No recalc ("same as calendar edits, which don't recompute") | Smallest diff | Leaves task dates silently wrong against the new working-time until an unrelated edit forces a recompute — the exact #1267 failure mode |

## Consequences

- **Easier:** UI/MCP/API clients can now manage non-working days; offline CPM is correct
  when holidays exist; editing a calendar definition now keeps dependent schedules true.
- **Harder / risk:** calendar-definition and exception edits now trigger CPM recomputes
  they previously didn't — a shared calendar edit fans out to every project using it.
  This is correct but is real work; it is coalesced per project through the existing
  outbox so a burst of edits collapses into one run each.
- **Follow-up (out of scope):** per-resource `CalendarException`-aware allocation in the
  board over-allocation signal remains the documented gap from ADR-0035 (#184); mobile
  (`packages/mobile`) consuming the new nested exceptions field is a separate client task.

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: api (projects viewset/serializer/urls, sync serializer), docs
- Migration required: **no** — `CalendarException` and `Calendar` models are unchanged
- API changes: yes — new `/calendars/{calendar_pk}/exceptions/` collection + detail
  routes; `SyncCalendarSerializer` gains a read-only nested `exceptions` array
- OSS or Enterprise: **OSS** (org-level calendar CRUD; no cross-program/portfolio surface)

### Durable Execution
1. Broker-down behaviour: reuses `scheduling/services.py::enqueue_recalculate`, which
   writes a `ScheduleRequest` outbox row and attempts immediate `.delay()`; on broker
   outage the row stays PENDING and `drain_schedule_queue` re-dispatches within 30 s.
   No new durability surface.
2. Drain task: reuses the existing `drain_schedule_queue` — same CPM-recompute semantics.
3. Orphan window: N/A — reuses the existing schedule-request outbox and its window;
   dispatch is deferred to `transaction.on_commit`, so rows are visible before dispatch.
4. Service layer: `scheduling/services.py::enqueue_recalculate(project_id, reason=CALENDAR_CHANGE)`.
5. API response on best-effort dispatch: the exception CRUD call is a synchronous DB
   write returning the exception object (201/200); the recompute is fire-and-forget via
   `on_commit`. No `task_id` is returned — consistent with every other write that
   triggers a background recompute.
6. Outbox cleanup: reuses the existing schedule-request outbox purge — no new rows type.
7. Idempotency: CPM recompute is deterministic and safe to run twice; `enqueue_recalculate`
   coalesces onto any PENDING row per project, so repeated exception edits collapse into
   one run. Unsafe HTTP mutations also honor `Idempotency-Key` via `IdempotencyMixin`.
8. Dead-letter / failure handling: reuses `ScheduleRequest` failure handling (retry +
   status on the outbox row) — no new dead-letter path.
