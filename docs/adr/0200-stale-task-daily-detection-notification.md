# ADR-0200: Stale-task daily detection and per-user notification

## Status
Accepted

## Context
PMs report "tasks I forgot in a working column" (typically Review) as the #1 unseen
slip cause — a card that stops moving is invisible until standup. We want a proactive
nudge: a daily scan that finds non-terminal tasks that have sat in their current status
longer than a configurable threshold and notifies the person responsible.

This rides directly on the notification pipeline shipped by #522 / ADR-0075 / ADR-0085
(own-task event notifications, #639): `notifications/services.py::create_event_notifications`
already fans out an in-app inbox row and (opt-in) queues email, gating delivery per-user
via `NotificationPreference (event_type, channel)`. The per-user settings page is
data-driven, so a new event type renders its toggle automatically once a preference row
exists.

**P3M layer:** Programs and Projects (single project / board). Data scope is one project's
tasks; no cross-project aggregation. **OSS** — this is core "run your program" tooling a PM
needs, not portfolio governance.

Forces:
- The Visiban source pattern is a per-board threshold; TruePPM has **no `Board` model** —
  a board is a view over `Sprint` + `Task` within a `Project`. Board-level config precedent
  is discrete fields on `Project` (`board_cadence`, `agile_features`) and `Sprint` (`wip_limit`).
- An existing `is_stalled`/`dwell_days` serializer verdict (ADR-0115 / #992) already exists
  for the **board-card chip** with a hardcoded 3-day dwell. That is a *visual, synchronous*
  verdict; this feature is an *asynchronous, opt-in, configurable-threshold notification*.
  They are deliberately separate concerns (different thresholds, different surfaces). Note the
  chip's `is_stalled` returns False for `percent_complete >= 100`, which excludes every
  `REVIEW` card (`REVIEW` coerces `percent_complete` to 100 in `Task.save()`); this feature
  deliberately does **not** copy that exclusion, because "forgot in Review" is the #1 case.
- Daily batch work must be durable and idempotent — a crashed or double-fired run must not
  spam users.

## Decision

1. **Threshold storage — `Project.stale_task_threshold_days` (`PositiveIntegerField`, default 7).**
   No new settings model, no `Sprint` field. Matches the discrete-field precedent for
   board-level config on `Project`. A per-sprint override is YAGNI. The field is exposed
   read/write on the existing `ProjectSerializer` (API-first: "if it's not in the API it
   doesn't exist"), validated `>= 1`, gated by the existing project-update RBAC (Admin/Owner).
   No dedicated web settings UI in this MR — deferred (the issue's UI scope is the per-user
   toggle only).

2. **Recipient scope — the task's assignee only.** If a task is unassigned we skip it: there
   is no single "person responsible" to nudge, and fanning out to every project member would
   be noise (and would notify Viewers). Unassigned stale cards are still surfaced by the
   synchronous board-card `is_stalled` chip. This keeps fan-out tight and the daily volume
   proportional to real ownership.

2b. **Staleness is defined by status column, not `percent_complete`.** Non-terminal =
   every `TaskStatus` except `COMPLETE`. A `REVIEW` card is functionally 100% but awaiting
   sign-off — it is exactly the target, so it is in scope (unlike the board-card chip).

3. **New event type `task.stale`** added to `NotificationEventType` + `DEFAULT_PREFERENCES`
   (`in_app` ON, `email` OFF — matches the conservative default-off-email policy from #522).
   Fan-out goes through `create_event_notifications`, deduping against existing **unread,
   un-archived** `task.stale` notifications for the same `(recipient, task)`.

4. **No new outbox/request model.** Durable execution is satisfied by (a) the beat task being
   idempotent via `@idempotent_task` singleton lock (`on_contention="skip"`) plus the unread
   dedupe, so a re-run creates zero duplicates; and (b) email delivery riding the **existing**
   `email_pending → drain_notification_emails` outbox drain (every 30 s). In-app rows are
   created directly (not `on_commit`-deferred) so they are visible immediately — consistent
   with the notifications app's existing convention.

5. **Scan index — partial index `(status, status_changed_at) WHERE NOT is_deleted`** on `Task`,
   matching the scan filter exactly and keeping the index small (excludes soft-deleted rows).

6. **No new WebSocket broadcast.** Notification inbox rows are polled (no notification WS
   channel exists); `create_event_notifications` writes DB rows only. The threshold field
   change rides the existing `Project` update path.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Threshold on `Project` (chosen) | Matches board-config precedent; one field; no new model | Not per-sprint (acceptable — YAGNI) |
| New `BoardSettings`/JSON blob model | Flexible future settings | New model + migration + join for a single int; premature |
| Threshold on `Sprint` | Per-board-instance override | Continuous/Kanban boards have no sprint; leaves non-sprint tasks unconfigurable |
| Recipient = all project editors | Nobody misses a nudge | Noise; notifies people not responsible; volume scales with team size |
| New `StaleTaskRequest` outbox model | Explicit durable row per dispatch | Redundant — idempotent beat + unread dedupe + existing email outbox already durable |
| Reuse the 3-day `is_stalled` threshold | One threshold to reason about | Conflates a visual chip with an opt-in notification; not configurable; would change board-card behavior |

## Consequences
- **Easier:** PMs get a Tuesday nudge instead of a Friday-standup surprise; the per-user
  toggle and email opt-in come for free from the #522 pipeline; re-running the job is safe.
- **Harder:** Two "stale" thresholds now exist (3-day chip vs configurable notification) —
  documented so they are not confused. The scan is a full-table filter (mitigated by the
  partial index).
- **Risks:** A very stale backlog on first enable could produce a burst of notifications
  (one per assigned non-terminal task past threshold). Bounded by dedupe (one unread per
  task) and by assignee-only scope; acceptable for a daily job.

## Implementation Notes
- **P3M layer:** Programs and Projects
- **Affected packages:** api (models, migration, serializer, tasks, beat schedule, notifications
  enum/services), web (event label + tests), docs
- **Migration required:** yes — `Task` partial index + `Project.stale_task_threshold_days` +
  `Notification` no-op enum widening is not a schema change (CharField). One migration, batched.
- **API changes:** yes — `ProjectSerializer` gains `stale_task_threshold_days`; a new
  `task.stale` `NotificationPreference` row surfaces on `/me/notification-preferences/`.
- **OSS or Enterprise:** OSS (`trueppm-suite`).

### Durable Execution
1. **Broker-down behaviour:** The daily scan is a Beat-dispatched task; if the broker is down
   at fire time Beat simply misses that tick and the next daily run picks up the same stale
   tasks (they are still stale). In-app rows are written synchronously in the DB inside the
   task; email delivery is queued via `email_pending` and drained by the existing outbox drain,
   so a broker outage between row-creation and email-send is covered by that drain. No direct
   `.delay()` durability gap because there is no downstream `.delay()` — the task does its work
   inline.
2. **Drain task:** Reuses the existing `notifications.drain_notification_emails` (every 30 s,
   `@idempotent_task(on_contention="skip")`) for email. No new drain — semantics match exactly
   (queue an email row, drain sends it). The scan itself is a Beat entry, not an outbox drain.
3. **Orphan window:** N/A for the scan (it reads committed task rows on a daily cron, not an
   in-flight outbox). Email uses the existing drain's 5-minute orphan window unchanged.
4. **Service layer:** New `notifications/services.py::create_stale_task_notifications(project_id,
   now=None)` (or task-local scan helper) that owns the query + dedupe + `create_event_notifications`
   call, kept out of the Celery wrapper for unit-testability with an injected clock.
5. **API response on best-effort dispatch:** N/A — no synchronous API triggers the scan; it is
   a scheduled job with no caller awaiting a task id.
6. **Outbox cleanup:** N/A — no new outbox rows. Notification rows follow the existing 90-day
   archive/retention policy already in the notifications app.
7. **Idempotency:** Singleton Redis lock (`@idempotent_task(lock_key_template="detect_stale_tasks",
   on_contention="skip")`) prevents concurrent runs; the unread `(recipient, task, event_type=
   task.stale, is_read=False, is_archived=False)` dedupe makes repeat runs create zero duplicates.
   Idempotency key = the existing-unread-notification predicate.
8. **Dead-letter / failure handling:** The scan is best-effort daily; a failed run is not retried
   (its work reappears next day because the tasks are still stale — silent re-attempt is correct
   and preferable to a retry storm). Email send failures are handled by the existing drain's
   `email_attempts < 3` retry-and-give-up path. No DLQ needed.
