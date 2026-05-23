# `transaction.on_commit` Durability Audit

**Issue:** #659 · **Date:** 2026-05-23 · **Trigger:** durability gap analysis after ADR-0080

## Why this audit exists

TruePPM defers async side effects to after the DB commit with
`transaction.on_commit(...)` so that a rolled-back request never fires a worker
or a broadcast. The risk that motivated this audit: any `on_commit` callback
that dispatches durable work (`.delay()`, `.apply_async()`, an external write)
**without first writing a durable row in the same transaction** silently loses
that work if the broker or channel layer is unavailable in the window between
commit and dispatch — with no PENDING row for a drain task to replay.

This document classifies every `transaction.on_commit` callsite in
`packages/api` so the durability surface is explicit rather than assumed.

## Classification rubric

| Bucket | Definition | Verdict |
|---|---|---|
| **outbox-protected** | Callback dispatches Celery work, but a durable outbox row was committed earlier in the same transaction. A Beat drain replays the row if dispatch fails. | Safe |
| **best-effort by design** | Callback only pushes a WebSocket event (`broadcast_board_event` / `broadcast_workshop_event`). Loss is recoverable because clients re-fetch via the sync delta protocol on reconnect. | Safe (acceptable loss) |
| **durability-hole** | Callback dispatches Celery work or performs an external write with **no** preceding outbox row and **no** client-pull recovery path. | Must fix |

### The outbox machinery (what "protected" means)

Four durable outbox models back every Celery-dispatching callback. Each has a
Beat drain task that re-dispatches stranded PENDING rows:

| Outbox model | Enqueue helper | Drain task | Consumer |
|---|---|---|---|
| `ScheduleRequest` (scheduling) | `enqueue_recalculate()` | `drain_schedule_queue` | CPM recompute |
| `WebhookDelivery` (webhooks) | `dispatch_webhooks()` | `drain_webhook_queue` | outbound webhook POST |
| `ImportRequest` (msproject) | `enqueue_import()` | import drain | MS Project import |
| `SprintCloseRequest` (projects) | `enqueue_sprint_close()` | `drain_sprint_close_requests` | sprint close transition |

Any callback that calls one of these helpers is outbox-protected *by definition*
— the helper writes the durable row before (or instead of) dispatching.

### The best-effort contract (why broadcasts are safe to lose)

`broadcast_board_event` (`apps/sync/broadcast.py`) and `broadcast_workshop_event`
(`apps/workshops/broadcast.py`) are **best-effort by design**. A broadcast is a
push optimization, not the source of truth: every event it carries is also
durably persisted in the DB before the broadcast is scheduled, and clients
reconcile their state by pulling the sync delta on (re)connect. If the channel
layer is down at commit time, the event is dropped and the connected client
recovers it on its next delta fetch. Losing a broadcast therefore loses nothing
durable. This contract is documented on the two primitives' docstrings; it is
**not** repeated as an inline comment on each of the 60 best-effort callsites —
that would duplicate one rationale 60 times and violate the repo's
comment-discipline rule (comments explain non-obvious *why*; the why here is a
property of the broadcast mechanism, stated once at its definition).

## Result

**91 callsites · 31 outbox-protected · 60 best-effort by design · 0 durability holes.**

No spot-fixes were required and no follow-up issues were filed: every
Celery-dispatching callback is already preceded by a committed outbox row with a
drain backstop, and every remaining callback is a recoverable broadcast.

> The grep count of `on_commit` *textual references* in `packages/api` is higher
> (≈108) because it includes docstrings, comments, and the outbox/broadcast
> machinery definitions (`enqueue_recalculate`, `dispatch_webhooks`,
> `enqueue_import`, `broadcast_board_event`, …) that are *called from*
> `on_commit` elsewhere but contain no callsite themselves. This audit counts
> only literal `transaction.on_commit(<callback>)` invocations.

### Note on #658 (`close_sprint` durability)

#658 reported `projects/services.py` dispatching `close_sprint.delay()` via
`on_commit` without an outbox row. That hole **does not exist on `main`**:
`enqueue_sprint_close()` writes a `SprintCloseRequest` PENDING row *before* the
deferred dispatch (services.py:108 → 126), the sprint state transition happens
inside the drained `close_sprint` task under `select_for_update` (not before
dispatch), and `drain_sprint_close_requests` reclaims orphaned rows every 30 s.
This was shipped under #234 (ADR-0037) before #658 was filed. The audit row at
`projects/services.py:126` confirms it. #658 is resolved with no code change.

### Note on `resources/views.py:455`

`ResourceViewSet.perform_destroy` calls `enqueue_recalculate()` **eagerly**
inside the request body rather than via `on_commit`. This is still
outbox-protected (the `ScheduleRequest` row is committed and drain-backstopped),
but it dispatches before commit rather than after. Harmless for durability;
noted for consistency. Not an `on_commit` callsite, so it is outside the table
below.

## Full classification

### `apps/projects/views.py` — 19 protected · 48 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 205 | `ProjectViewSet.perform_create` | broadcast `project_created` | best-effort |
| 209 | `ProjectViewSet.perform_create` | webhooks `project.created` (WebhookDelivery) | outbox-protected |
| 216 | `ProjectViewSet.perform_update` | broadcast `project_updated` | best-effort |
| 225 | `ProjectViewSet.perform_destroy` | broadcast `project_deleted` | best-effort |
| 1260 | `TaskViewSet.perform_create` | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 1261 | `TaskViewSet.perform_create` | broadcast `task_created` | best-effort |
| 1266 | `TaskViewSet.perform_create` | broadcast `task_updated` (parent) | best-effort |
| 1270 | `TaskViewSet.perform_create` | webhooks `task.created` (WebhookDelivery) | outbox-protected |
| 1278 | `TaskViewSet.perform_update` | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 1279 | `TaskViewSet.perform_update` | broadcast `task_updated` | best-effort |
| 1292 | `TaskViewSet.perform_update` | webhooks `task.updated` (WebhookDelivery) | outbox-protected |
| 1354 | `TaskViewSet.perform_destroy` | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 1355 | `TaskViewSet.perform_destroy` | broadcast `task_deleted` | best-effort |
| 1358 | `TaskViewSet.perform_destroy` | webhooks `task.deleted` (WebhookDelivery) | outbox-protected |
| 1398 | `TaskViewSet.approve_estimates` | broadcast `task_updated` | best-effort |
| 1474 | `TaskViewSet.accept_suggestion` | broadcast `task_updated` | best-effort |
| 1724 | `BaselineViewSet.perform_create` | broadcast `baseline_created` | best-effort |
| 1736 | `BaselineViewSet.perform_destroy` | broadcast `baseline_deleted` | best-effort |
| 1768 | `BaselineActivateView.post` | broadcast `baseline_activated` | best-effort |
| 1843 | `DependencyViewSet.perform_create` | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 1846 | `DependencyViewSet.perform_create` | broadcast `dependency_created` | best-effort |
| 1856 | `DependencyViewSet.perform_create` | webhooks `dependency.created` (WebhookDelivery) | outbox-protected |
| 1866 | `DependencyViewSet.perform_update` | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 1869 | `DependencyViewSet.perform_update` | broadcast `dependency_updated` | best-effort |
| 1879 | `DependencyViewSet.perform_destroy` | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 1882 | `DependencyViewSet.perform_destroy` | broadcast `dependency_deleted` | best-effort |
| 1885 | `DependencyViewSet.perform_destroy` | webhooks `dependency.deleted` (WebhookDelivery) | outbox-protected |
| 1986 | tasks reorder | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 1987 | tasks reorder | broadcast `tasks_reordered` | best-effort |
| 2127 | tasks restructure | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 2128 | tasks restructure | broadcast `tasks_restructured` | best-effort |
| 2260 | tasks restructure | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 2261 | tasks restructure | broadcast `tasks_restructured` | best-effort |
| 2378 | tasks reparent | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 2379 | tasks reparent | broadcast `tasks_restructured` | best-effort |
| 2550 | tasks bulk mutate | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 2551 | tasks bulk mutate | broadcast `tasks_bulk_mutated` | best-effort |
| 2629 | `RiskViewSet.perform_create` | broadcast `risk_created` | best-effort |
| 2639 | `RiskViewSet.perform_update` | broadcast `risk_updated` | best-effort |
| 2649 | `RiskViewSet.perform_destroy` | broadcast `risk_deleted` | best-effort |
| 2707 | `RiskCommentViewSet.perform_create` | broadcast `risk_comment_created` | best-effort |
| 2839 | `BoardColumnConfigView.put` | broadcast `board_config_updated` | best-effort |
| 2887 | `BoardSavedViewListView.post` | broadcast `board_view_created` | best-effort |
| 2937 | `BoardSavedViewDetailView.patch` | broadcast `board_view_updated` | best-effort |
| 2950 | `BoardSavedViewDetailView.delete` | broadcast `board_view_deleted` | best-effort |
| 3601 | phases reorder | broadcast `phases_reordered` | best-effort |
| 3604 | phases reorder | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 3738 | `PhaseViewSet.perform_create` | broadcast `task_created` | best-effort |
| 3752 | `PhaseViewSet.perform_update` | broadcast `task_updated` | best-effort |
| 3781 | `PhaseViewSet.perform_destroy` | broadcast `task_deleted` | best-effort |
| 3830 | `ProjectCustomFieldViewSet.perform_create` | broadcast `project_custom_fields_updated` | best-effort |
| 3844 | `ProjectCustomFieldViewSet.perform_update` | broadcast `project_custom_fields_updated` | best-effort |
| 3858 | `ProjectCustomFieldViewSet.perform_destroy` | broadcast `project_custom_fields_updated` | best-effort |
| 3931 | `SprintViewSet.perform_create` | broadcast `sprint_created` | best-effort |
| 3949 | `SprintViewSet.perform_update` | broadcast `sprint_updated` | best-effort |
| 3970 | `SprintViewSet.perform_destroy` | broadcast `sprint_deleted` | best-effort |
| 4046 | `SprintViewSet.activate` | broadcast `sprint_activated` | best-effort |
| 4138 | `SprintViewSet.cancel` | broadcast `sprint_cancelled` | best-effort |
| 5294 | ApiToken create (`_broadcast_mint`) | broadcast `api_token_minted` | best-effort |
| 5338 | ApiToken destroy (`_broadcast_revoke`) | broadcast `api_token_revoked` | best-effort |
| 5472 | `TaskAttachmentViewSet.perform_create` | broadcast `task_attachment_created` | best-effort |
| 5499 | `TaskAttachmentViewSet.perform_destroy` | broadcast `task_attachment_deleted` | best-effort |
| 5657 | `TaskCommentViewSet.perform_create` | broadcast `task_comment_created` | best-effort |
| 5685 | `TaskCommentViewSet.perform_update` | broadcast `task_comment_updated` | best-effort |
| 5716 | `TaskCommentViewSet.perform_destroy` | broadcast `task_comment_deleted` | best-effort |

> `TaskCommentViewSet.perform_create` (5657): @mention notifications are written
> synchronously inside the transaction body, not in the `on_commit` callback, so
> they are durable; the callback itself only broadcasts.

### `apps/resources/views.py` — 4 protected · 0 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 231 | `ProjectResourceViewSet.destroy` | `enqueue_recalculate` + broadcast `roster_changed` | outbox-protected |
| 662 | `TaskResourceViewSet.perform_create` | `enqueue_recalculate` + broadcast `assignment_created` | outbox-protected |
| 685 | `TaskResourceViewSet.perform_update` | `enqueue_recalculate` + broadcast `assignment_updated` | outbox-protected |
| 704 | `TaskResourceViewSet.perform_destroy` | `enqueue_recalculate` + broadcast `assignment_deleted` | outbox-protected |

### `apps/access/views.py` — 0 protected · 3 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 154 | `ProjectMembershipViewSet.create` | broadcast `member_added` | best-effort |
| 215 | `ProjectMembershipViewSet.partial_update` | broadcast `member_role_changed` | best-effort |
| 260 | `ProjectMembershipViewSet.destroy` | broadcast `member_removed` | best-effort |

### `apps/scheduling/views.py` — 2 protected · 0 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 72 | `trigger_schedule` | `enqueue_recalculate` (reason=MANUAL) | outbox-protected |
| 405 | `VelocitySuggestionViewSet.accept` | `enqueue_recalculate` (reason=TASK_CHANGE) | outbox-protected |

### `apps/webhooks/views.py` — 1 protected · 0 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 114 | `WebhookViewSet.test_ping` | `deliver_webhook.delay()` after WebhookDelivery row (L94) | outbox-protected |

### `apps/msproject/views.py` — 1 protected · 0 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 112 | `MsProjectImportView.post` | `enqueue_import` after ImportRequest row (L104) | outbox-protected |

### `apps/projects/services.py` — 1 protected · 1 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 126 | `enqueue_sprint_close` | `close_sprint.delay()` after SprintCloseRequest row (L108) | outbox-protected |
| 925 | `recompute_milestone_rollup` | broadcast `milestone_rollup_updated` | best-effort |

### `apps/projects/inbound_sync.py` — 2 protected · 1 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 334 | `upsert_inbound_task` | `enqueue_recalculate` (ScheduleRequest) | outbox-protected |
| 335 | `upsert_inbound_task` | broadcast `task_created`/`task_updated` | best-effort |
| 336 | `upsert_inbound_task` | `dispatch_webhooks` (WebhookDelivery) | outbox-protected |

### `apps/projects/retro_services.py` — 1 protected · 1 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 161 | `promote_retro_action_item` | `enqueue_recalculate` + 2× broadcast | outbox-protected |
| 237 | `pull_carryover_item_to_sprint` | broadcast `task_updated` | best-effort |

### `apps/projects/tasks.py` — 0 protected · 1 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 181 | `close_sprint` | broadcast `sprint_closed` | best-effort |

> The durable CPM recompute in `close_sprint` is a synchronous `ScheduleRequest`
> write (L159) inside the task body, not in the `on_commit` callback; only the
> `sprint_closed` broadcast is deferred and best-effort.

### `apps/workshops/services.py` — 0 protected · 3 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 36 | `start_workshop` | broadcast `workshop_started` | best-effort |
| 66 | `end_workshop` | broadcast `workshop_ended` | best-effort |
| 97 | `force_end_workshop` | broadcast `workshop_ended` | best-effort |

### `apps/workshops/consumers.py` — 0 protected · 2 best-effort

| line | function | side effect | class |
|---|---|---|---|
| 132 | `WorkshopConsumer._participant_join` | broadcast `participant_joined` (presence) | best-effort |
| 162 | `WorkshopConsumer._participant_leave` | broadcast `participant_left` (presence) | best-effort |

## How to keep this audit true

When you add a `transaction.on_commit` callback:

- **Broadcast only** (`broadcast_board_event` / `broadcast_workshop_event`) → best-effort, no action needed; the durability contract is on the primitive.
- **Dispatch Celery work** (`.delay()` / `.apply_async()`) → you **must** commit an outbox row first (`enqueue_recalculate`, `dispatch_webhooks`, `enqueue_import`, `enqueue_sprint_close`, or a new outbox model with its own drain). Never `.delay()` from `on_commit` without a durable row.
- **External write** (HTTP, email) → route through an outbox + drain; never fire directly from `on_commit`.

`broadcast-check` (pre-MR gate) verifies new mutations defer their broadcast via
`on_commit`; this audit is the durability complement — it verifies that the
*durable* side effects behind those mutations are outbox-backed.
