---
title: WebSocket API
description: Real-time collaboration events over WebSocket — channels, event taxonomy, and the workshop protocol.
---

TruePPM pushes real-time collaboration events over WebSocket. OpenAPI 3.0 cannot
describe WebSocket channels, so this page is the reference for the WS surface that
`docs/api/openapi.json` does not cover.

There are two endpoints, both scoped to a single project by its UUID.

| Endpoint | Consumer | Purpose |
|----------|----------|---------|
| `ws/v1/projects/{project_id}/` | `ProjectConsumer` | Board/schedule events + presence |
| `ws/v1/projects/{project_id}/workshop/` | `WorkshopConsumer` | Live workshop session (cursors + edits) |

`{project_id}` is the project's UUID. Use `wss://` against a TLS deployment and
`ws://` only for local development.

> **Program-scoped channels are planned.** A `ws/v1/programs/{program_id}/`
> endpoint will land in a future release (#836) to push program-scoped events in
> real time. It will **not** ship in 0.3 — program-scoped events will be
> delivered over WebSocket in a later release. Subscribe to the per-project
> channels in the meantime.

## Authentication

The JWT **access token** is supplied as a `token` query parameter on the connect
URL (WebSocket handshakes cannot carry an `Authorization` header):

```
wss://trueppm.example.com/ws/v1/projects/3f9a…/?token=<access_token>
```

The connection is authenticated and authorized before the server accepts it.

## Close codes

If the server rejects the connection it closes with one of these application
close codes (rather than accepting and then dropping):

| Code | Meaning |
|------|---------|
| `4001` | Missing, invalid, or expired token |
| `4003` | Authenticated but lacks the required role on the project (Member+ to subscribe) |
| `4004` | (workshop endpoint only) no active `WorkshopSession` for the project |

A client that receives `4001` should refresh its access token and reconnect; a
persistent `4001` means the session has expired and the user must re-authenticate.
Retryable transport drops (network loss, server restart) use the standard
`1006`/`1001` codes and should be reconnected with backoff.

## Board channel — server → client

Every board/schedule event on `ws/v1/projects/{project_id}/` arrives as a JSON
envelope:

```json
{ "event_type": "<name>", "payload": { ... } }
```

`event_type` is a `snake_case` name. Clients dispatch on it and typically
invalidate the corresponding cache (the web client maps these to TanStack Query
keys). The set is open-ended and grows as features land; current event types
include:

- **Tasks**: `task_created`, `task_updated`, `task_deleted`, `tasks_reordered`,
  `tasks_restructured`, `tasks_bulk_mutated`
- **Dependencies**: `dependency_created`, `dependency_updated`, `dependency_deleted`
- **Scheduling**: `cpm_complete`, `cpm_error`, `task_run_started`,
  `task_run_progress`, `task_run_completed`, `task_run_failed`, `task_run_cancelled`
- **Baselines**: `baseline_created`, `baseline_activated`, `baseline_deleted`
- **Risks**: `risk_created`, `risk_updated`, `risk_deleted`
- **Sprints**: `sprint_created`, `sprint_updated`, `sprint_deleted`,
  `sprint_activated`, `sprint_cancelled`, `sprint_closed`, `milestone_rollup_updated`
- **Comments / attachments**: `task_comment_created`, `task_comment_updated`,
  `task_comment_deleted`, `task_attachment_created`, `task_attachment_deleted`,
  `comment_created`
- **Roster / assignments**: `roster_changed`, `assignment_created`,
  `assignment_updated`, `assignment_deleted`
- **Board config**: `board_config_updated`, `board_view_created`,
  `board_view_updated`, `board_view_deleted`
- **Membership / project**: `member_added`, `member_role_changed`,
  `member_removed`, `project_updated`, `project_archived`, `project_unarchived`,
  `project_transferred`, `project_deleted`, `project_hard_deleted`
- **Presence**: `presence_join`, `presence_leave`

> **Event-name convention.** WebSocket `event_type` values are **`snake_case`**
> across the board — including presence, which previously used a dot-namespaced
> `presence.join` / `presence.leave` (aligned to snake_case in 0.2, #828).
>
> Webhook event names are deliberately **dot-namespaced** (`task.created`,
> `task.updated`, …) — a different transport with a different audience
> (external integrations expect dotted topic-style names). So the *same* domain
> event is `task_created` over the WebSocket and `task.created` in a webhook
> payload. This is an intentional per-transport distinction, not drift.

Treat broadcast delivery as **best-effort**: events may be missed during a
reconnect, so a client should refetch the affected resource on reconnect rather
than rely on having seen every event. Event payloads are intentionally minimal
(usually `{ "id": "<uuid>" }` or a small id set) — fetch the resource for the
full state.

## WebSocket ↔ webhook event taxonomy

The *same* domain event uses two different naming conventions depending on the
transport: WebSocket `event_type` values are **`snake_case`** (`task_created`),
while webhook events are **dot-namespaced** `noun.verb` (`task.created`). This is
an intentional per-transport distinction, not drift — see the convention note
above. The two event sets also do not fully overlap: some WS events have no
webhook counterpart (and vice-versa).

### Board events broadcast over WebSocket

These are emitted via `broadcast_board_event()`. The table below highlights the
events with a webhook equivalent plus a representative selection of the
**WS-only** events. It is **illustrative, not exhaustive** — the complete,
authoritative set of WebSocket event types is frozen in the API test suite
(`packages/api/tests/apps/sync/test_broadcast.py`, `FROZEN_WS_EVENT_TYPES`), which
fails CI if a new `broadcast_board_event()` call introduces an event type without
adding it to that frozen set. Events with no webhook counterpart are marked
**WS-only**.

| WebSocket event (`snake_case`) | Webhook event (`noun.verb`) |
|--------------------------------|-----------------------------|
| `task_created` | `task.created` |
| `task_updated` | `task.updated` |
| `task_deleted` | `task.deleted` |
| `dependency_created` | `dependency.created` |
| `dependency_deleted` | `dependency.deleted` |
| `dependency_updated` | **WS-only** |
| `project_created` | `project.created` |
| `project_updated` | **WS-only** |
| `project_archived` | **WS-only** |
| `project_unarchived` | **WS-only** |
| `project_deleted` | **WS-only** |
| `backlog_reranked` | **WS-only** |
| `baseline_activated` | **WS-only** |
| `baseline_deleted` | **WS-only** |
| `board_view_created` | **WS-only** |
| `board_view_updated` | **WS-only** |
| `board_view_deleted` | **WS-only** |
| `milestone_rollup_updated` | **WS-only** |
| `phases_reordered` | **WS-only** |
| `program_closed` | **WS-only** |
| `program_reopened` | **WS-only** |
| `program_deleted` | **WS-only** |
| `risk_created` | **WS-only** |
| `risk_updated` | **WS-only** |
| `risk_deleted` | **WS-only** |
| `sprint_created` | **WS-only** |
| `sprint_updated` | **WS-only** |
| `sprint_deleted` | **WS-only** |
| `sprint_scope_changed` | **WS-only** |
| `demo_reordered` | **WS-only** |
| `demo_presenter_set` | **WS-only** |
| `review_note_set` | **WS-only** |
| `flagged_for_backlog` | **WS-only** |
| `tasks_bulk_mutated` | **WS-only** |
| `tasks_reordered` | **WS-only** |
| `tasks_restructured` | **WS-only** |
| `team_member_changed` | **WS-only** |

### WS-only events on other channels

Presence and scheduling-progress events are broadcast over channels other than
the board channel and have no webhook counterpart:

| WebSocket event | Channel / purpose |
|-----------------|-------------------|
| `presence_join` | Presence (a user connected) — **WS-only** |
| `presence_leave` | Presence (a user disconnected) — **WS-only** |
| `cpm_complete` | Scheduling progress (CPM run finished) — **WS-only**¹ |
| `cpm_error` | Scheduling progress (CPM run failed) — **WS-only**¹ |

¹ The `cpm_*` scheduling-progress events relate **approximately** to the webhook
`schedule.recalculated` event — both signal that a schedule recalculation
occurred — but they are not a one-to-one mapping (the webhook fires once per
recalculation; the WS events stream the lifecycle of a run). Treat the
correspondence as loose.

### Webhook-only events

These webhook events have **no** WebSocket broadcast — they are delivered only to
configured webhook endpoints:

| Webhook event | Notes |
|---------------|-------|
| `schedule.recalculated` | Loosely relates to the `cpm_*` WS events (see above). |
| `task.assigned` | No WS broadcast. |
| `task.assignee_changed` | No WS broadcast. |
| `task.mentioned` | No WS broadcast. |
| `task.due_date_changed` | No WS broadcast. |

The OSS webhook event set is capped at 11 events: `task.created`,
`task.updated`, `task.deleted`, `dependency.created`, `dependency.deleted`,
`schedule.recalculated`, `project.created`, `task.assigned`,
`task.assignee_changed`, `task.mentioned`, and `task.due_date_changed`.

## Workshop channel

`ws/v1/projects/{project_id}/workshop/` requires an **active** `WorkshopSession`
(otherwise `4004`). Messages are relayed to all other participants and are
**not** echoed back to the sender. The consumer validates the message type against
its `ALLOWED_EVENT_TYPES` allow-list; the seven accepted client message types are:

- `cursor`
- `cursor_move`
- `phase_rename`
- `phase_add`
- `phase_move`
- `task_add`
- `task_move`

> **`cursor` and `cursor_move` are both accepted.** `cursor` is the legacy name and
> `cursor_move` is the current name; the consumer accepts either for backward
> compatibility.

The server also broadcasts `participant_joined` / `participant_left` as
participants connect and disconnect.
