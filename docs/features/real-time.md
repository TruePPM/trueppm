# Real-Time Collaboration

TruePPM uses Django Channels 4 to push project changes to connected clients over WebSocket.

## Connecting

```
ws://localhost:8000/ws/projects/{project_id}/?token=<jwt>
```

Authentication is via a JWT `?token=` query parameter. The JWT must belong to a user with at least Member role (ordinal ≥ 1) on the project. Viewer-role connections are rejected with WebSocket close code 4003.

## Event format

All events share this envelope:

```json
{
  "type": "board.event",
  "event": "<event_name>",
  "payload": { ... }
}
```

## Events

### Schedule events

Fired after the Celery `recalculate_schedule` task completes.

| Event | Payload |
|-------|---------|
| `schedule_updated` | `{"project_id": "..."}` |

### Task events

Fired after task create, update, or delete.

| Event | Payload |
|-------|---------|
| `task_created` | `{"task_id": "..."}` |
| `task_updated` | `{"task_id": "..."}` |
| `task_deleted` | `{"task_id": "..."}` |

### Dependency events

| Event | Payload |
|-------|---------|
| `dependency_created` | `{"dependency_id": "..."}` |
| `dependency_deleted` | `{"dependency_id": "..."}` |

### Membership events

| Event | Payload |
|-------|---------|
| `member_added` | `{"membership_id": "...", "user_id": "...", "role": 1}` |
| `member_role_changed` | `{"membership_id": "...", "user_id": "...", "role": 2}` |
| `member_removed` | `{"membership_id": "...", "user_id": "..."}` |

## Broadcast safety

Broadcasts are always deferred inside `transaction.on_commit()`. This guarantees:

1. The event only fires if the database transaction committed successfully — no phantom events for rolled-back writes
2. Multiple writes in a single atomic block produce a single commit and therefore a single broadcast opportunity

```python
# Example from the source — every mutation follows this pattern
transaction.on_commit(
    lambda: broadcast_board_event(project_id, "task_updated", {"task_id": str(instance.pk)})
)
```

## Channel layer

The channel layer uses Redis (configured via `REDIS_URL`). All `api` and `celery` containers share the same Redis instance, so broadcasts from the Celery worker reach WebSocket clients connected to any `api` container. This makes horizontal scaling of the API safe without additional coordination.

## Client example (JavaScript)

```javascript
const ws = new WebSocket(
  `ws://localhost:8000/ws/projects/${projectId}/?token=${jwtToken}`
);

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.event === 'schedule_updated') {
    // Re-fetch CPM fields for all tasks
    fetchSchedule(msg.payload.project_id);
  }
  if (msg.event === 'task_updated') {
    fetchTask(msg.payload.task_id);
  }
};
```
