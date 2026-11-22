---
title: "Real-Time Collaboration"
description: "WebSocket broadcasts for all project mutations via Django Channels."
documentedFor: "0.5"
---

**This page is for developers** connecting to TruePPM's live-update channel — end users don't configure anything here; changes just appear on screen as teammates make them. Under the hood, TruePPM pushes project changes to every connected client over a WebSocket connection the moment they happen, so a schedule move or a card drag shows up for everyone else without a page refresh.

## Connecting

Mint a single-use ticket (`POST /api/v1/ws/ticket/`, 30-second TTL), then connect:

```text
ws://localhost:8000/ws/v1/projects/{project_id}/?ticket=<ticket>
```

Authentication uses a short-lived, single-use ticket so no JWT ever appears in a
WebSocket URL or access log (RFC 6750 §2.3) — see the [WebSocket API reference](/api/websockets/) for the handshake. The deprecated `?token=<jwt>` parameter is disabled by default (it leaked the JWT into access logs) and is opt-in via `TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED` for one last release. Requires at least the Team Member role on the project. Viewers are refused with close code 4003, and the project's `can_subscribe_live` field reports the same rule ahead of time, so the web app does not open a socket for a Viewer at all: the status bar shows **No live updates**, tasks and the Monte Carlo forecast refresh from the REST API every 5 minutes instead of streaming, and other views (boards, risks, decisions, comments) show current data when reopened. If a connected user's membership is revoked or demoted below Team Member mid-session, the server evicts the live socket immediately with close code 4003 — revocation does not wait for the client to disconnect — and the web app stops reconnecting. Refusals are sent after the handshake is accepted, so the browser receives the code; see [Close codes](/api/websockets/#close-codes).

## Event format

Every event arrives as a JSON envelope with an `event_type` name and a minimal `payload`:

```json
{
  "event_type": "<event_name>",
  "payload": { ... }
}
```

Payloads are intentionally small (usually just `{"id": "<uuid>"}`) — fetch the resource for full state. Treat delivery as best-effort: refetch affected resources after a reconnect rather than relying on having seen every event.

## Events

The complete, authoritative event catalog is frozen in the API test suite (`packages/api/tests/apps/sync/test_broadcast.py`, `FROZEN_WS_EVENT_TYPES`) and documented in the [WebSocket API reference](/api/websockets/). The events you will see most often:

### Schedule

A schedule recompute broadcasts two events when the CPM run commits:

| Event | Payload |
|-------|---------|
| `cpm_complete` | `{"project_finish": "...", "critical_count": N, "status_date": "..."}` — `critical_count` is how many tasks are critical; the id list is not sent on the socket (ships in 0.5) |
| `task_dates_updated` | `{"count": N, "tasks": [{"id", "early_start", "early_finish", "late_start", "late_finish", "total_float", "free_float", "is_critical", "planned_start", "duration", "scheduled_start", "milestone_at_day_end"}, ...]}` — per-task CPM date deltas so Gantt bars slide without a full re-fetch. `scheduled_start` is the start of the task's bar (its span), which can precede `early_start` once work is underway; `milestone_at_day_end` is `true` when a milestone sits at the end of its `early_start` day because it follows work, and `false` for every other task. `count` and `tasks` cover only the tasks whose CPM fields actually changed in that recalculation, not every task in the project — a single-field edit typically ships a handful of rows regardless of project size. When more than 500 tasks changed and more than 500 of them moved a bar (a first-ever pass, a calendar change, a project-start shift), the payload is `{"count": N, "truncated": true}` and clients should re-fetch. When few bars moved, the payload is split instead (see below). No frame is sent when a pass moves no tasks; `cpm_complete` always fires. |

When more than 500 tasks changed but no more than 500 of them moved a bar, the payload is split instead of truncated. This is the usual shape of a critical-path edit: the project finish moves, so every task's late dates and float re-anchor, but only the edited chain's bars move. `tasks` carries the bar-moving rows in full. `float_tasks` carries every other changed row as a compact array, `[id, late_start, late_finish, total_float, free_float]`, in a fixed order that only ever gains columns at the end. If more than 5,000 rows changed only their float, the payload sends `"float_truncated": true` in place of `float_tasks`: splice `tasks`, then re-fetch to refresh float. `count` is always the total number of changed tasks, and a task appears in at most one of the two arrays. A client that ignores `float_tasks` still draws every bar correctly but shows stale float until its next re-fetch.

:::note[Ships in 0.5]
The split payload (`float_tasks` and `float_truncated`) ships in 0.5. In the current release, a recalculation that changes more than 500 tasks always sends `{"count": N, "truncated": true}`, including a critical-path edit that moves only a few bars.
:::

### Tasks

| Event | Payload |
|-------|---------|
| `task_created` | `{"id": "..."}` |
| `task_updated` | `{"id": "...", "changed_fields": [...], "version": N \| null, "actor_id": "..." \| null, "ts": "..."}` — a field-level delta naming which fields changed, never their values; see [WebSocket API](/api/websockets/) for when `version` and `actor_id` are `null` |
| `task_deleted` | `{"id": "..."}` |

### Dependencies

| Event | Payload |
|-------|---------|
| `dependency_created` | `{"id": "..."}` |
| `dependency_updated` | `{"id": "..."}` |
| `dependency_deleted` | `{"id": "..."}` |
| `dependency_accepted` | `{"id": "..."}` |
| `dependency_rejected` | `{"id": "..."}` |

### Risks

| Event | Payload |
|-------|---------|
| `risk_created` / `risk_updated` / `risk_deleted` | `{"id": "..."}` |

### Sprints and baselines

Sprint lifecycle events (`sprint_created`, `sprint_updated`, `sprint_deleted`, `sprint_activated`, `sprint_closed`, `sprint_cancelled`, `sprint_scope_changed`) and baseline events (`baseline_created`, `baseline_activated`, `baseline_deleted`) follow the same minimal-payload convention.

### Members

| Event | Payload |
|-------|---------|
| `member_added` | `{"membership_id": "...", "user_id": "...", "role": 100}` |
| `member_role_changed` | `{"membership_id": "...", "user_id": "...", "role": 200}` |
| `member_removed` | `{"membership_id": "...", "user_id": "..."}` |

### Presence

| Event | Payload |
|-------|---------|
| `presence_join` | `{"user_id": "...", "display_name": "..."}` |
| `presence_leave` | `{"user_id": "...", "display_name": "..."}` |

Presence is held in Valkey under a 60-second TTL that each open socket re-arms on a
server-side timer. **The roster tracks who is connected, not who is active** — sitting on
a quiet project without touching anything keeps you listed. The TTL exists to reap a
socket that died without a clean disconnect (a killed worker, a network partition), so a
name disappears within a minute of the connection genuinely going away. Clients send no
heartbeat and need none.

**There are no row-level or per-field locks**, and the project socket is currently
receive-only — it accepts no client frames. Presence tells you who is in a project; it
does not tell you what they are touching. Concurrent edits are resolved where they always
were: a stale write returns `409` against `server_version` and the client is asked to
reload, with no automatic merge.

**TruePPM will not lock a row against you.** A soft lock expires on inactivity and on
disconnect and never gates the write, so it cannot prevent the conflict it appears to
prevent — and every way it fails looks reassuring rather than broken, which is worse than
not drawing it. Any edit-awareness TruePPM adds will be advisory for that reason: it may
tell you someone else is typing, and it will never stop you typing.

Beyond these, the catalog also covers comments, attachments, assignments and roster changes, board configuration and saved views, programs, and project lifecycle — see the [WebSocket API reference](/api/websockets/) for the full taxonomy and the WebSocket ↔ webhook event mapping.

## Broadcast safety

All broadcasts are deferred inside `transaction.on_commit()` — events only fire if the database write committed successfully. No phantom events for rolled-back transactions.

## Channel layer

Uses [Valkey](https://valkey.io) (the BSD-licensed Linux Foundation fork of Redis; wire-compatible) configured via `REDIS_URL`. All `api` and `celery` containers share the same Valkey instance, so Celery-originated broadcasts (e.g. `cpm_complete`) reach WebSocket clients connected to any API container — safe for horizontal scaling. Existing Redis-compatible managed services (ElastiCache, Memorystore, Azure Cache for Redis) work as drop-in alternatives.

## JavaScript example

```typescript
// Mint a single-use ticket, then connect — keeps the JWT out of the URL.
const { ticket } = await fetch('/api/v1/ws/ticket/', {
  method: 'POST',
  headers: { Authorization: `Bearer ${jwt}` },
}).then((r) => r.json());

const ws = new WebSocket(
  `ws://localhost:8000/ws/v1/projects/${projectId}/?ticket=${ticket}`
);

ws.onmessage = (event) => {
  const { event_type, payload } = JSON.parse(event.data);
  if (event_type === 'cpm_complete') fetchSchedule(projectId);
  if (event_type === 'task_updated') fetchTask(payload.id);
};
```
