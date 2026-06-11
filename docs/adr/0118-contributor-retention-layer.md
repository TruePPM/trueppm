# ADR-0118: Contributor retention layer — blocker flag, My Work grouping, signal-only notifications, role-scoped settings

## Status
Accepted

## Context
Wave 4 targets Priya (Team Member / Contributor) retention. Four VoC-sourced issues
share one persona and one job-to-be-done — "make TruePPM feel like *my* tool, not a
PM cockpit I'm forced to log into":

- **#476** — a contributor needs to flag that work is blocked.
- **#484** — "My Work" must group a contributor's tasks the way they think about their
  day (Today / This Sprint / Upcoming), with no CPM/WBS vocabulary, and surface
  blockers prominently.
- **#855** — notification defaults are too noisy; Priya hard-NO'd un-opted-in push.
  She needs a one-click "Signal-only" profile.
- **#856** — the settings shell shows Methodology/Workflow/Roles/Groups to everyone,
  reading as "not my tool". A contributor should see Notifications + Profile only.

P3M layer: **Programs and Projects / Operations** (a contributor acting on their own
assigned work). OSS — nothing here aggregates across programs or governs an org.

## Decision

### 1. Blocker flag (#476) — reason-only, explicit
Add `Task.blocked_reason: TextField(blank, default="")`. "Flagged blocked" ⇔ the
reason is non-empty. **One field, not a boolean+reason pair**, because:
- it avoids a name collision with the *existing* computed `is_blocked` annotation
  (ADR-0035), which is a **dependency-readiness** signal ("has incomplete
  predecessors") owned by the board card — a deliberately different concept;
- a blocker with no reason is low-signal, so requiring the reason is good UX.

The flag is **explicit and human-raised**, never derived from predecessors. It rides
the existing `PATCH /tasks/{id}/` path, so it inherits task-edit permission (Member+;
Viewers 403). The existing `task_updated` `broadcast_board_event` (already deferred via
`transaction.on_commit`, already seed-replay-suppressed) carries the visual update — no
new board event.

### 2. `task.blocked` notification (#855)
Add `TASK_BLOCKED = "task.blocked"` to `NotificationEventType` and two
`DEFAULT_PREFERENCES` rows (in-app ON, email OFF — ADR-0085 opt-in-email rule). Fires in
`TaskViewSet.perform_update` on the **unblocked→blocked transition only** (empty →
non-empty `blocked_reason`), to the **assignee**, never the actor who raised it. Reuses
the existing `_notify_event` → `create_event_notifications` on-commit synchronous path —
no new Celery task, drain, or outbox.

### 3. My Work grouping (#484) — extend `/me/work/`, server-computed bucket
Do **not** add `GET /tasks/my-work/`. ADR-0065 makes `GET /me/work/` the canonical
contributor surface; extend it. `MeWorkView.get_queryset` annotates a `_group_rank` and
the serializer maps it to a `group` string ∈ `{today, this_sprint, upcoming}`. Rules
(using the existing ADR-0065 `due` cascade `actual_finish → planned_start →
early_finish → sprint.finish_date`):
- **today** — `due ≤ today` and status ≠ COMPLETE (due today or overdue, still open);
- **this_sprint** — not today, and the task is in the ACTIVE sprint;
- **upcoming** — everything else.

The flat paginated list is pre-sorted `group_rank → blocked-first → due → priority → id`
so groups are contiguous and pagination still works (ADR-0065 keeps LimitOffset). The
bucket decision is a **server fact** — API-first, identical across web/mobile/MCP. The
serializer also exposes `blocked_reason` and an `is_blocked` (= non-empty reason); within
My Work `is_blocked` is unambiguous because the dependency-readiness signal is absent
here by design.

### 4. Shared `/me/` role signal (#855 + #856)
Add `max_project_role`, `workspace_role`, and `can_access_admin_settings` to
`GET /auth/me/`. `can_access_admin_settings` = Admin+ in any project **or** Admin+ at the
workspace. Both features gate on this one server-computed boolean instead of the web
client fanning out per-project membership calls to re-derive "am I an admin anywhere".
API-first, MCP-reachable.

### 5. Signal-only preset (#855) — bulk write, not a new model
`POST /me/notification-preferences/apply-preset/ {preset: "signal_only"|"everything"}`
bulk-writes the existing per-(event, channel) rows. `signal_only` = in-app ON for
`{task.blocked, task.due_date_changed}`, everything else OFF; `everything` restores
`DEFAULT_PREFERENCES`. No "profile" model — the matrix stays the single source of truth,
so the data-driven settings page (ADR-0085) needs no special-casing. The web shows the
simplified "Signal-only" card to non-admins (`can_access_admin_settings=false`) with a
"Show all notification types" escape to the existing full matrix.

### 6. Settings gating (#856)
The settings shell hides the Workspace/Project admin scopes for non-admins
(`can_access_admin_settings=false`), collapsing to a single **Personal** group
(Notifications + Profile). Server already enforces (workspace PATCH is
`WorkspaceRole>=ADMIN`, ADR-0087); this is the visibility match, not the enforcement.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| `is_blocked` boolean + `blocked_reason` | toggle maps to a checkbox | collides with the ADR-0035 dependency annotation; two fields for one concept |
| Derive "blocked" from incomplete predecessors | no new field | conflates readiness with a human signal; fires on every not-started successor; user explicitly chose an explicit field |
| New `GET /tasks/my-work/` | clean URL | duplicates ADR-0065's `/me/work/`; two surfaces to keep in sync |
| Grouped buckets in the response body | no client grouping | breaks LimitOffset pagination; groups span pages |
| New `NotificationProfile` model | named presets | parallel source of truth vs the matrix; breaks ADR-0085's data-driven page |
| Per-role `DEFAULT_PREFERENCES` at user-create | "default" is literal | no stable role at user-create (per-project role varies); brittle |

## Consequences
- **Easier**: a contributor sees their day the way they think about it; one click to a
  quiet notification profile; admin chrome disappears for non-admins. Every value is a
  server fact (group, blocked, admin-tier) so mobile and MCP get them for free.
- **Harder**: two meanings of "blocked" now coexist (dependency-readiness on the board
  card vs the human flag on My Work). Documented; they live on different surfaces.
- **Risks**: migration `0070` is contended (in-flight branches #851/#1106 also cut 0070)
  — renumber whichever lands last; the change is purely additive so a renumber is
  mechanical.

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: api, web
- Migration required: yes — projects `0070` (additive `blocked_reason` on task +
  historicaltask). No notifications migration (enum/defaults are runtime constants).
- API changes: yes — `Task.blocked_reason` (writable); `/me/work/` adds `group`,
  `is_blocked`, `blocked_reason`; `/auth/me/` adds `max_project_role`, `workspace_role`,
  `can_access_admin_settings`; new `POST /me/notification-preferences/apply-preset/`;
  new `task.blocked` notification event.
- OSS or Enterprise: **OSS**.

### Durable Execution
1. Broker-down behaviour: N/A for the blocker write itself (synchronous DB write). The
   `task.blocked` notification reuses the existing `_notify_event` on-commit synchronous
   path (no broker at dispatch) — same as `task.assigned`/`task.due_date_changed`.
2. Drain task: reuses the existing notification path; no new drain.
3. Orphan window: N/A — no outbox row; notification rows are created in the on-commit
   callback.
4. Service layer: `notifications.services.create_event_notifications` via the existing
   `_notify_event` trampoline.
5. API response on best-effort dispatch: N/A — the PATCH returns the updated task
   synchronously; the notification is a commit-deferred side effect.
6. Outbox cleanup: N/A.
7. Idempotency: the unblocked→blocked transition guard (empty→non-empty `blocked_reason`,
   captured pre-save) ensures re-saving an already-blocked task does not re-notify.
   `apply-preset` is naturally idempotent (it sets absolute enabled values).
8. Dead-letter / failure handling: inherits the existing notification subsystem's
   behaviour (in-app row is the record; email drain handled separately, ADR-0085).
