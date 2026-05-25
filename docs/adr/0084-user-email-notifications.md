# ADR-0084: Per-User Email Notifications for Task Events

## Status
Proposed

## Context

Issue #639 ships the email-notifications slice descoped from #302: let a user opt
in to email for their own-task events (assigned, mentioned, due-date moved,
commented-on). It was written as "new `UserNotificationPreference` model +
`NOTIFICATION_CHANNELS` registry + SMTP", but since then ADR-0075 (#310/#311)
landed a `notifications` app that **already** contains most of the substrate:

- **`NotificationPreference(user, event_type, channel, enabled)`** — `event_type`
  is `CharField(64)` and `channel` is `CharField(32)`, both deliberately open
  ("+ future" / "Enterprise extensions" per the model docstring), unique on
  `(user, event_type, channel)`. This is *exactly* the shape #639 specifies for
  `UserNotificationPreference`.
- **`Notification`** per-recipient inbox with `email_pending` / `email_sent_at` /
  `email_failed_at` / `email_attempts` fields and a partial index for the drain.
- **`drain_notification_emails`** Beat task (30s, idempotent, 5-min orphan window,
  3-attempt cap) + `_send_email_for_notification` / `_render_email`.
- **`NOTIFICATION_CHANNELS`** registry + `NotificationChannel` ABC (scaffolded,
  nothing registered).
- **`/me/settings/notifications/`** page (`NotificationPreferencesPage`) that
  renders whatever event×channel matrix the server returns and auto-saves toggles.

The gap: the existing email path is **mention-specific** — `_send_email_for_notification`
returns False when `notif.mention is None`, and `_render_email` reads
`mention.task_comment`. The four #639 events (task.assigned, task.due_date_changed,
comment_on_my_task) are not mentions.

**P3M layer:** Programs and Projects / Operations (OSS) — a team member managing
their own notification reach.

## Decision

### 1. Reuse `NotificationPreference` — do NOT add `UserNotificationPreference`

The existing model is byte-for-byte what #639 asks for; its open CharFields were
designed (ADR-0075, ADR-0049) to hold exactly these new event-type strings and the
`email` channel. A second near-identical table would fragment the per-user
preference surface across two models, two endpoints, and two UI pages. #639's
"new model" wording predates ADR-0075 landing.

- Add the #639 notification event types as **string constants matching
  `WebhookEventType` values** where one exists (`task.assigned`,
  `task.due_date_changed`) plus the notification-only `comment_on_my_task`.
  Keep them in a `notifications` enum (`NotificationEventType` gains members) so
  the event-name source of truth is shared with webhooks where they overlap.
- Extend `DEFAULT_PREFERENCES` with conservative seeds (Priya's VoC blocker):
  for each own-task event, seed `in_app=ON, email=OFF`. Email is strictly opt-in;
  no event emails a user who hasn't turned it on. `task.mentioned` already has its
  ADR-0075 default (in_app ON, email OFF) — unchanged.
- The existing `/me/settings/notifications/` page renders the new rows with no
  code change (it's data-driven). Frontend work is labels/grouping only.

### 2. Register `email` (and `in_app`) in `NOTIFICATION_CHANNELS`

Register OSS channel handlers at the integrations `AppConfig.ready()`, mirroring
the `OUTGOING_CHANNEL_PROVIDERS` pattern from ADR-0083. The handler's `send(user,
event)` is the seam Enterprise uses for `slack_dm`/`teams_dm`/`sms`. In OSS the
`email` handler queues an email Notification; `in_app` creates the inbox row. The
preference serializer validates `channel` against `NOTIFICATION_CHANNELS.keys()`.

### 3. Generalize `Notification` + the email path beyond mentions

Add to `Notification`:
- `event_type = CharField(max_length=64, blank=True)` — the event that produced a
  non-mention notification (blank for mention-sourced rows).
- `subject = CharField(blank=True)` + `body = TextField(blank=True)` — the
  pre-rendered email content for event-sourced rows.

`mention` stays nullable. A Notification is now **either** mention-sourced
(`mention` set, render from the comment as today) **or** event-sourced
(`event_type`+`subject`+`body` set). `_render_email` branches: mention present →
existing render; else → return the stored `(subject, body)`.
`_send_email_for_notification` drops the hard `mention is None → False` guard and
instead requires *either* a mention *or* a non-empty subject. Migration adds the
three nullable/blank fields — additive, no backfill.

### 4. Event → notification dispatch

New `notifications/services.py::create_event_notifications(event_type, recipients,
subject, body, project_id)` — bulk-creates Notification rows, honoring each
recipient's `NotificationPreference`: always create the in-app row when `in_app`
is enabled; set `email_pending=True` only when `email` is enabled. Deferred via
`transaction.on_commit` at the event hook points (no count needed in the API
response, and we must not notify for a rolled-back mutation):

| Event | Hook point | Recipient resolution |
|---|---|---|
| `task.assigned` | `TaskViewSet.perform_update` + `accept_suggestion` | the new assignee (not the actor) |
| `task.due_date_changed` | `TaskViewSet.perform_update` | the task's assignee/owner |
| `comment_on_my_task` | `TaskCommentViewSet.perform_create` | task assignee, when commenter ≠ assignee and not already @mentioned |
| `task.mentioned` | (unchanged) `create_mention_notifications` | already implemented |

These hook points already build the webhook payload + fire `dispatch_webhooks` in
`on_commit` (ADR-0083); the notification dispatch is a sibling `on_commit` call,
not a new traversal. Recipients are de-duplicated against the actor and against
mention recipients so a single PATCH never double-notifies.

### 5. SMTP — OPEN DECISION (see Alternatives)

#639 says "SMTP delivery via `EmailMessage` + `DEFAULT_FROM_EMAIL`. No new infra."
The design mock shows a full **writable** workspace SMTP admin (host/port/
credentials/DKIM/throttle/transport switch). These conflict. Recommendation:
ship a **read-only Email & SMTP status page** in MR-B (transport mode, From
identity, deliverability summary — sourced from Django settings/Helm), and file
a follow-up for the writable config model. Rationale: a writable SMTP model means
encrypted-at-rest credential storage + a dynamic `EmailBackend` swap + transport
validation — material new infra and a credential-handling security surface that
#639 explicitly scoped out. **Flagged for product confirmation before build.**

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Reuse `NotificationPreference`** (chosen) | DRY; existing API + UI + drain reused; one preference surface | deviates from #639's literal "new model" wording |
| New `UserNotificationPreference` table | matches the issue text | duplicates an identical model, endpoint, and page; two sources of truth |
| New event-notification model separate from `Notification` | clean separation from mentions | duplicates the inbox + drain + email-state machine; the UI would need a second feed |
| **Read-only SMTP status page** (recommended) | honors #639 "no new infra"; delivers the surface; no credential storage | not the full mock's writable form |
| Writable SMTP config model + dynamic backend | full mock parity | encrypted-credential storage, backend-swap, validation — own feature + security review; beyond #639 |

## Consequences

- **Easier:** one per-user preference model/API/page; email reach for own-task
  events with a conservative opt-in default; a registry seam for Enterprise
  channels.
- **Harder:** `Notification` now has two shapes (mention vs event) — `_render_email`
  and any inbox renderer must handle both. Recipient-resolution rules per event
  are logic that must stay correct as task/comment flows evolve.
- **Risks:** double-notification if dedup is wrong (mitigated by actor + mention
  dedup); email default must stay OFF (Priya) — enforced by `DEFAULT_PREFERENCES`
  and a test.

## Implementation Notes

- **P3M layer:** Programs and Projects / Operations
- **Affected packages:** api (notifications, integrations, projects), web
- **Migration required:** yes — `Notification` adds `event_type`/`subject`/`body`
  (all blank-default, additive); no new table. `NotificationPreference` unchanged.
- **API changes:** existing `/me/notification-preferences/` returns more rows
  (new event types); no new endpoint for prefs. SMTP status endpoint only if the
  read-only page is approved.
- **OSS or Enterprise:** OSS. `grep -r trueppm_enterprise packages/` stays zero;
  channels register via `AppConfig.ready()`.

### Durable Execution
1. **Broker-down behaviour:** Email is not sent inline. The dispatch creates
   `Notification` rows with `email_pending=True` inside the request transaction;
   the existing `drain_notification_emails` Beat task sends them. No broker is
   touched on the request path, so a broker outage only delays the drain.
2. **Drain task:** Reuses `drain_notification_emails` (ADR-0075) unchanged — the
   new event-sourced rows are ordinary `Notification` rows with `email_pending`.
3. **Orphan window:** Unchanged — `EMAIL_ORPHAN_WINDOW_MINUTES = 5`.
4. **Service layer:** `notifications/services.py::create_event_notifications`
   (new) + the existing `create_mention_notifications`. Both are the only paths
   that create Notification rows.
5. **API response on best-effort dispatch:** N/A — notification creation rides the
   triggering task/comment response; nothing async is surfaced to the caller.
6. **Outbox cleanup:** Reuses `archive_old_notifications` (nightly, read+90d).
   No new purge.
7. **Idempotency:** A duplicate task PATCH that doesn't change the assignee/date
   creates no notification (the ADR-0083 before/after snapshot guards the event).
   The drain is idempotent on `email_pending`/`email_sent_at`.
8. **Dead-letter / failure handling:** Unchanged — 3 attempts then
   `email_pending=False` + `email_failed_at` stamped; surfaced in logs. No DLQ.
