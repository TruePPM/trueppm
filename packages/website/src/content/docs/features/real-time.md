---
title: "Real-Time Collaboration"
description: "WebSocket broadcasts for all project mutations via Django Channels."
---

TruePPM uses Django Channels 4 to push project changes to connected clients over WebSocket.

## Connecting

```
ws://localhost:8000/ws/projects/{project_id}/?token=<jwt>
```

Authentication via `?token=` JWT. Requires Member role or above (ordinal ≥ 1). Viewers are rejected with close code 4003.

## Event format

```json
{
  "type": "board.event",
  "event": "<event_name>",
  "payload": { ... }
}
```

## Events

### Schedule

| Event | Payload |
|-------|---------|
| `schedule_updated` | `{"project_id": "..."}` |

### Tasks

| Event | Payload |
|-------|---------|
| `task_created` | `{"task_id": "..."}` |
| `task_updated` | `{"task_id": "..."}` |
| `task_deleted` | `{"task_id": "..."}` |

### Dependencies

| Event | Payload |
|-------|---------|
| `dependency_created` | `{"dependency_id": "..."}` |
| `dependency_deleted` | `{"dependency_id": "..."}` |

### Members

| Event | Payload |
|-------|---------|
| `member_added` | `{"membership_id": "...", "user_id": "...", "role": 1}` |
| `member_role_changed` | `{"membership_id": "...", "user_id": "...", "role": 2}` |
| `member_removed` | `{"membership_id": "...", "user_id": "..."}` |

## Broadcast safety

All broadcasts are deferred inside `transaction.on_commit()` — events only fire if the database write committed successfully. No phantom events for rolled-back transactions.

## Channel layer

Uses Redis (configured via `REDIS_URL`). All `api` and `celery` containers share the same Redis instance, so Celery-originated broadcasts (e.g. `schedule_updated`) reach WebSocket clients connected to any API container — safe for horizontal scaling.

## JavaScript example

```typescript
const ws = new WebSocket(
  `ws://localhost:8000/ws/projects/${projectId}/?token=${jwt}`
);

ws.onmessage = (event) => {
  const { event: name, payload } = JSON.parse(event.data);
  if (name === 'schedule_updated') fetchSchedule(payload.project_id);
  if (name === 'task_updated')     fetchTask(payload.task_id);
};
```
