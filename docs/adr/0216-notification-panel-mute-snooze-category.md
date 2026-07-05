# ADR-0216: Notification panel — inline mute, snooze, and category filter

## Status
Accepted

## Context

Source: VoC audit of the v2 navigation chrome (epic #1163, ADR-0134), 2026-07-02. Raised by
**Priya (Team Member)** as a hard-NO, daily — the adoption failure-mode persona whose
disengagement rots the data layer. The notification panel today offers only a read-state axis
(All / Unread / Archived); Priya feels notification spam in the bell but the only way to turn
it down is to leave the panel for `/me/settings/notifications` — a route she would never find.

Concretely (from code recon, `apps/notifications/models.py` +
`features/shell/NotificationPanel.tsx`):
- No per-notification **snooze** ("remind me later").
- No inline **mute** of a notification *type* where the noise is felt.
- No **category** filter — mentions, task events, schedule signals, and project events all
  collapse into one undifferentiated feed.
- The desktop panel already has a friendly empty state, but the mobile route
  (`features/me/NotificationListPage.tsx`) renders a plain `<p>` that reads as "broken."
- Backend preference plumbing already exists: `NotificationPreference` (global per-`event_type`
  in-app/email on/off, #855) and `ProjectNotificationPreference` (matrix + quiet hours, #674).
  There is **no** per-notification `snoozed_until`, no `mute`, and no `category` field.

**P3M layer:** Operations (a contributor managing their own inbox) → **OSS**.

## Decision

Surface the noise controls **where the noise is felt** — inline in the panel and the mobile
route — reusing the existing preference plumbing and adding the minimum new model surface.

1. **Snooze (per-notification, new state).** Add `Notification.snoozed_until =
   DateTimeField(null=True, blank=True, db_index=True)`. A snoozed row is hidden from the
   All/Unread views while `snoozed_until > now()`, then reappears (still unread) once the time
   passes — no Celery needed; it is a pure query-time filter. Row action offers presets
   (1 hour, 3 hours, tomorrow 9am) via a new `POST /me/notifications/{id}/snooze/` action
   (body `{until}` or `{preset}`), and an un-snooze. A "Snoozed" filter chip lets the user see
   what they deferred.

2. **Mute a type (reuses `NotificationPreference`).** The row action "Mute notifications like
   this" resolves the row's `event_type` to the user's global `NotificationPreference` for that
   type and sets its **in-app** channel off — turning off *future* delivery of that type, which
   is the correct semantic for "I don't want these." No new model. It reuses the existing
   `NotificationPreferenceViewSet` PATCH; the panel gets the event_type→preference mapping and a
   confirmation toast with undo. Mention rows (no `event_type`) are not type-muteable (you mute
   a *type*, and a mention is a person addressing you) — their row omits the mute action.

3. **Category filter (derived, no new field).** Classify each notification into a **category**
   derived from `event_type`, exposed as a read-only serializer field and a `?category=` list
   filter:
   - `mentions` — `mention_individual`, `mention_group`, and mention-sourced rows (blank event_type, `mention` FK set)
   - `tasks` — `task.assigned`, `task.due_date_changed`, `task.blocked`, `task.stale`, `comment_on_my_task`, `sprint.task_rescheduled`
   - `signals` — `signal.*`, `milestone.forecast_shifted`
   - `project` — `project.deleted`
   The mapping lives in one place (`apps/notifications/categories.py`) consumed by both the
   serializer field and the queryset filter, so they never drift. The panel and mobile route
   gain a category selector orthogonal to the read-state tabs.

4. **Friendly empty states everywhere.** Extend the panel's existing friendly empty state to
   the mobile route and to each category/snoozed filter ("You're all caught up", "Nothing
   snoozed", category-specific copy). The two duplicated `FILTERS` arrays
   (`NotificationPanel.tsx` + `NotificationListPage.tsx`) are unified into one shared source so
   the read-state + category dimensions stay in sync.

5. **API:** `GET /me/notifications/` gains `?category=` and excludes `snoozed_until > now()`
   from the default/unread views (a `?snoozed=true` param surfaces them). The PATCH writable-field
   allowlist is unchanged (snooze is its own action; mute goes through the preferences endpoint).
   `snoozed_until` and `category` are added to the notification serializer (read side).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Snooze via `snoozed_until` query-time filter (chosen)** | No Celery; reappearance is automatic at query time; one nullable indexed column | A snoozed unread row still counts unless the unread-count query also excludes it (must update `useUnreadNotificationCount`'s server filter) |
| Snooze via a scheduled Celery "un-snooze" task | Explicit reappearance event | New periodic task + durability surface for zero benefit — query-time filter is strictly simpler |
| Mute via a new per-type `NotificationMute` model | Decoupled from delivery preferences | Duplicates `NotificationPreference`, which already models exactly "in-app channel for this type off"; two sources of truth for "muted" |
| Category as a stored `Notification.category` column | Filter is a plain indexed equality | Redundant with `event_type`; a backfill migration + drift risk between column and type; derivation is O(1) and centralized |

## Consequences

- **Easier:** Priya turns down a noisy type or defers a notification without leaving the panel —
  clearing the load-bearing 🔴. Categories make a busy feed scannable.
- **Harder:** the unread-count query, the list query, and the panel all must agree on the
  snoozed-exclusion rule; the category mapping must stay exhaustive as new `event_type` values
  are added (a test asserts every `NotificationEventType` maps to a category).
- **Risks:**
  - A snoozed row that still increments the bell badge would defeat the feature. Mitigation:
    `useUnreadNotificationCount` server filter excludes `snoozed_until > now()`; test covers it.
  - Muting a type from the panel silently affecting email too would surprise the user.
    Mitigation: the inline mute toggles the **in-app** channel only; email is untouched and its
    control stays in settings; toast copy says "muted in your inbox."

## Implementation Notes

- **P3M layer:** Operations
- **Affected packages:** api (notifications model + migration 0007, serializer, viewset snooze
  action + category/snoozed filters, a `categories.py` mapping), web (NotificationPanel,
  NotificationListPage, NotificationRow inline actions, shared FILTERS source, useNotifications
  hooks + query-key changes for category/snoozed, api types)
- **Migration required:** yes — `notifications` `0008_notification_snoozed_until` (one nullable
  indexed column; no data migration).
- **API changes:** yes — `snooze`/un-snooze action, `?category=`/`?snoozed=` filters, two new
  read-only serializer fields; OpenAPI regenerated.
- **OSS or Enterprise:** OSS.

### Durable Execution
1. **Broker-down behaviour:** N/A — snooze/mute are synchronous DB writes (a `snoozed_until`
   stamp and a preference PATCH); no Celery dispatch. Reappearance is a query-time filter, not
   an event.
2. **Drain task:** N/A — no async work introduced.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** category derivation is a pure function in `apps/notifications/categories.py`;
   snooze is a viewset action writing one field. No Celery service.
5. **API response on best-effort dispatch:** N/A — snooze returns the updated notification (200);
   mute returns the updated preference (200).
6. **Outbox cleanup:** N/A.
7. **Idempotency:** snooze is idempotent (setting `snoozed_until` is last-writer-wins; re-snoozing
   overwrites the timestamp harmlessly); un-snooze to null is idempotent; mute is a set-to-false
   preference toggle, idempotent.
8. **Dead-letter / failure handling:** N/A — no task; a failed write is a normal synchronous
   request error, transaction rolls back.
