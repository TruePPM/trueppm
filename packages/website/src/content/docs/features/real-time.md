---
title: "Real-Time Collaboration"
description: "WebSocket broadcasts for all project mutations via Django Channels."
---

TruePPM uses Django Channels 4 to push project changes to connected clients over WebSocket.

## Connecting

Mint a single-use ticket (`POST /api/v1/ws/ticket/`, 30-second TTL), then connect:

```
ws://localhost:8000/ws/v1/projects/{project_id}/?ticket=<ticket>
```

Authentication uses a short-lived, single-use ticket so no JWT ever appears in a
WebSocket URL or access log (RFC 6750 §2.3) — see the [WebSocket API reference](/api/websockets/) for the handshake. The deprecated `?token=<jwt>` parameter is disabled by default (it leaked the JWT into access logs) and is opt-in via `TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED` for one last release. Requires at least the Member role on the project. Viewers are rejected with close code 4003. If a connected user's membership is revoked or demoted below Member mid-session, the server evicts the live socket immediately with close code 4003 — revocation does not wait for the client to disconnect.

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
| `cpm_complete` | `{"project_finish": "...", "critical_path": [...]}` |
| `task_dates_updated` | `{"count": N, "tasks": [{"id", "early_start", "early_finish", "late_start", "late_finish", "total_float", "free_float", "is_critical", "planned_start", "duration"}, ...]}` — per-task CPM date deltas so Gantt bars slide without a full re-fetch. When too many tasks moved to ship economically, the payload is `{"count": N, "truncated": true}` and clients should re-fetch. |

### Tasks

| Event | Payload |
|-------|---------|
| `task_created` | `{"id": "..."}` |
| `task_updated` | `{"id": "..."}` |
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

Beyond these, the catalog also covers comments, attachments, assignments and roster changes, board configuration and saved views, programs, project lifecycle, and workshops — see the [WebSocket API reference](/api/websockets/) for the full taxonomy and the WebSocket ↔ webhook event mapping.

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
