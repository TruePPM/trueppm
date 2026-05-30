# WebSocket API

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

## Workshop channel

`ws/v1/projects/{project_id}/workshop/` requires an **active** `WorkshopSession`
(otherwise `4004`). Messages are relayed to all other participants and are
**not** echoed back to the sender. The consumer is message-type-agnostic; current
client message types are `cursor`, `phase_rename`, `task_add`, and `phase_add`.
The server also broadcasts `participant_joined` / `participant_left` as
participants connect and disconnect.
