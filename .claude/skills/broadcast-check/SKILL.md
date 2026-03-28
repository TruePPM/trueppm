---
name: broadcast-check
model: sonnet
description: >
  WebSocket real-time broadcast audit for TruePPM. Use when adding or modifying any
  write operation (create, update, delete) on board-scoped resources to verify
  broadcast_board_event() is correctly wired, deferred with transaction.on_commit(),
  and safe against fanout races.
---

# Broadcast Check Skill

You are auditing TruePPM's real-time WebSocket broadcast layer for a new or modified
mutation.

## Architecture

```
Client mutation → DRF ViewSet → Model.save() → transaction.on_commit()
                                                       ↓
                                            broadcast_board_event.delay()  [Celery]
                                                       ↓
                                            Redis pub/sub channel group
                                                       ↓
                                            Django Channels consumer → WebSocket clients
```

Key invariant: **broadcasts must never fire inside an open transaction.** If the
database rolls back after a broadcast, clients receive stale/phantom data.

## Checklist

### Triggering
- [ ] Every create/update/delete on a project-scoped model fires `broadcast_board_event()`
- [ ] Broadcasts are wrapped in `transaction.on_commit()` — never called directly
- [ ] The Celery task is called with `.delay()` (async), never called synchronously
- [ ] Broadcasts include enough data for clients to update in-place (avoids full refetch)

### Payload Safety
- [ ] Broadcast payload is serialized with a read serializer (not the write serializer)
- [ ] Payload does not include fields users in the channel group are not permitted to see
- [ ] `server_version` is included so clients can detect ordering / conflict
- [ ] Large payloads (e.g., full schedule recalc) use a delta format, not the full object graph

### Channel Group Scoping
- [ ] Broadcasts are scoped to `project_{project_pk}` channel group — no global broadcasts
- [ ] Cross-project resources (shared calendars, resources) broadcast to all affected project groups
- [ ] Event type string is namespaced: `project.task.updated`, `project.dependency.created`, etc.

### Consumer Safety
- [ ] Consumers authenticate on `connect()` and re-validate project membership
- [ ] Consumers do not perform synchronous ORM queries in the event handler (use async ORM)
- [ ] Consumers handle `project.deleted` by closing the connection gracefully
- [ ] Fan-out load: for projects with >500 members, broadcast is rate-limited or batched

### Missing Broadcasts
- [ ] Schedule recalculation result (CPM outputs) broadcasts updated task dates
- [ ] Baseline create/restore broadcasts all affected task dates
- [ ] Member add/remove broadcasts a `project.membership.changed` event

## Output Format

State the verdict: **PASS**, **FAIL**, or **NEEDS REVIEW**.

For each issue:
```
### [CRITICAL|HIGH|MEDIUM|LOW] Issue Title
**File**: path:line
**Problem**: What is missing or wrong
**Fix**: Exact code or pattern needed
```

If the mutation is correct, confirm: which event type fires, which channel group,
and that `transaction.on_commit()` wraps the call.
