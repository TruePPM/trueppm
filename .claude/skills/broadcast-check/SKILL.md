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

The set of "writes" is structural — *anything that changes a row another user could be watching* — not a hardcoded list. Look for these patterns in the diff:

- `.save()`, `.create()`, `.update_or_create()`, `.delete()`, `.update(...)`, `bulk_create`, `bulk_update`, `objects.filter(...).delete()`
- Implicit writes inside DRF `perform_create` / `perform_update` / `perform_destroy`
- Action methods that mutate state — every `@action` whose method list contains `post`, `patch`, `put`, or `delete`
- Celery tasks that mutate project-scoped state (e.g. `recalculate_schedule.delay()` writing task dates)

Checklist:
- [ ] Every write above fires the project broadcast for the affected resource
- [ ] Broadcasts are wrapped in `transaction.on_commit()` — never called directly inside the atomic block
- [ ] If the broadcast triggers a Celery task, the task is called with `.delay()` (async), never called synchronously
- [ ] Broadcasts include enough data for clients to update in-place (avoids full refetch)
- [ ] Bulk operations (e.g. reordering 50 tasks) broadcast **once** with the full updated set — not once per row. Inspect for `broadcast_*_event(...)` calls inside `for` loops or comprehensions.

### Payload Safety
- [ ] Broadcast payload is serialized with a read serializer (not the write serializer)
- [ ] **Per-recipient field-leak check** — a broadcast fans out to every connected subscriber on the channel without filtering. Any field that the REST serializer hides for a subset of roles (e.g. admin-only metadata, owner-only fields, internal scheduling state) **must** also be either (a) absent from the broadcast payload entirely, or (b) filtered per-recipient at the consumer's `<event_handler>`. When a serializer's `to_representation` strips a field based on `context['request'].user`, the broadcast layer needs the same gate. Audit every new "stripped on REST, broadcast as-is" pattern as HIGH.
- [ ] `server_version` is included so clients can detect ordering / conflict
- [ ] Large payloads (e.g., full schedule recalc) use a delta format, not the full object graph
- [ ] **Terminal-event payload shape** — for `*.deleted` events, payload should be `{"<resource>_uid": "<uid>"}` only. Adding integer/UUID PKs to deletion payloads (`"task_id"`, `"project_id"`) creates contract drift — every other deletion event uses uid-only and clients build that assumption.
- [ ] **`transaction.on_commit()` closures must capture plain values, not ORM instances** — a closure that holds an ORM `Task`, `Project`, etc. carries an object that may be evicted, mutated, or deleted between the atomic-block exit and the on_commit fire. Build the payload dict inside the atomic block, then pass it through default-argument values to the closure:

  ```python
  # WRONG — closure holds ORM instances; payload may serialize stale or deleted state
  with transaction.atomic():
      task.save()
      def _send():
          data = TaskSerializer(task, context={"project": project}).data
          broadcast_project_event(project.id, "project.task.updated", data)
      transaction.on_commit(_send)

  # RIGHT — payload built inside the atomic block, closure carries plain data
  with transaction.atomic():
      task.save()
      project_id = project.id
      payload = TaskSerializer(task, context={"project": project}).data
      transaction.on_commit(
          lambda pid=project_id, pl=payload: broadcast_project_event(pid, "project.task.updated", pl)
      )
  ```

### Channel Group Scoping
- [ ] Broadcasts are scoped to `project_{project_pk}` channel group — no global broadcasts
- [ ] Cross-project resources (shared calendars, resources, cross-project dependencies) broadcast to **all** affected project groups, not just one
- [ ] **Event-name contract: `noun.verb_past` with a dot separator** — `project.task.updated`, `project.dependency.created`, `project.member.removed`. Underscored or non-past-tense forms (`task_updated`, `task.update`) are a regression — the schema is `{event, data}` and the names are part of the public WebSocket contract. Renaming an event is a breaking change for any connected client.
- [ ] Sub-resource writes broadcast on the parent's channel group — easy to miss for resources nested under a project (dependencies, baselines, custom fields, comments). A `Dependency.delete()` should fire `project.dependency.deleted` on `project_{project_pk}`, not be silent.

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
