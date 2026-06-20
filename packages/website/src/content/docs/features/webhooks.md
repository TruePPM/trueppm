---
title: Webhooks
description: Outbound HTTP callbacks for project events — integrate TruePPM with CI systems, Slack, or custom tooling.
---


:::note[New events in 0.2 (alpha)]
The base webhook delivery feature shipped in 0.1. The four new event types described here (`task.*` lifecycle additions) were added in **TruePPM 0.2** (available since the `0.2.0-alpha.1` pre-release).
:::

Webhooks let you subscribe to TruePPM project events and receive an HTTP POST to a URL you control when those events occur. Common uses: posting notifications to Slack, triggering a CI pipeline when a milestone is resolved, or syncing changes to an external system.

## Registering a webhook

Register a webhook from the **Integrations** page (`Project → Settings →
Integrations` or `Program → Settings → Integrations`) or via the API:

```http
POST /api/v1/projects/{project_id}/webhooks/
Content-Type: application/json

{
  "url": "https://hooks.example.com/trueppm",
  "secret": "your-shared-secret",
  "events": ["task.created", "task.updated", "schedule.recalculated"],
  "format": "generic"
}
```

`events` is an array of one or more event type strings (see below). Omit `events` to subscribe to all event types. `format` selects how the payload is rendered — `generic` (default) or `slack` (see [Payload format](#payload-format)).

**Permissions**: requires Admin role on the project (or program, for program-scoped webhooks).

### Project vs. program scope

A webhook is scoped to exactly one project **or** one program:

- **Project** — `/api/v1/projects/{id}/webhooks/` — fires for events on that one project.
- **Program** — `/api/v1/programs/{id}/webhooks/` — fires for events on **any** project in the program. Configure one endpoint once instead of copying it into every child project.

Program-scoped reads require program Viewer+; mutations require program Admin. The two scopes are additive: a project event reaches both its own project webhooks and its program's webhooks.

## Payload format

Each webhook renders its payload in one of two OSS formats, set per subscription via the `format` field:

| Format | What is sent |
|--------|--------------|
| `generic` (default) | The raw TruePPM event envelope, unchanged (see [Payload shape](#payload-shape)). |
| `slack` | A Slack incoming-webhook message (`text` + a single attachment). Discord and Mattermost incoming webhooks accept the same shape, so one format covers all three. |

Point a `slack`-format webhook at a Slack/Discord/Mattermost incoming-webhook URL and messages render in-channel with no consumer-side parsing. Richer formats (Slack App, Teams, PagerDuty) are an Enterprise feature and register against the same extension point without an OSS change.

## Event types

OSS fires **14 event types** (a deliberate hard cap):

| Event | When fired |
|-------|-----------|
| `task.created` | A task is created |
| `task.updated` | A task field is changed |
| `task.deleted` | A task is deleted |
| `task.assigned` | A task's assignee transitions from nobody to a user |
| `task.assignee_changed` | A task is reassigned from one user to another |
| `task.mentioned` | A new comment mentions a user |
| `task.due_date_changed` | A task's planned date changes (see note) |
| `dependency.created` | A task link (FS/SS/FF/SF) is created |
| `dependency.deleted` | A task link is deleted |
| `schedule.recalculated` | The CPM scheduler completes a recalculation |
| `project.created` | A new project is created in the organization |
| `sprint.activated` | A sprint transitions PLANNED → ACTIVE |
| `sprint.closed` | A sprint is closed (carries the completion snapshot — see note) |
| `sprint.scope_changed` | A mid-sprint scope injection is **accepted** into the commitment |

The last four task events were added in 0.2 (available since the `0.2.0-alpha.1` pre-release). A single PATCH that both reassigns a task and moves its date fires `task.updated` **plus** the specific events — subscribe to whichever you want.

The three `sprint.*` events land in **0.3** so external dashboards, Slack, and CI can observe the sprint cadence. `sprint.scope_changed` fires only when a mid-sprint injection is *accepted* (it models scope that entered the commitment) — never on a silent injection or a reject.

:::caution[`sprint.closed` velocity is privacy-gated]
The `sprint.closed` payload carries the completion snapshot (`completed_points`, `completed_task_count`, `goal_outcome`) — this is team velocity. A webhook consumer is external to the team, so these fields are sent only when the team has explicitly shared the `velocity` signal outward (the team raises the `velocity` signal's audience to `program_shared` in the project's signal-privacy settings). Otherwise the three fields are `null` and a `velocity_suppressed: true` marker is added so consumers keep a stable payload shape. The committed plan (`committed_points`, `committed_task_count`) is the team's published plan, not a performance metric, so it is never gated.
:::

:::caution[`task.due_date_changed` currently tracks `planned_start`]
`Task` has no dedicated deadline field yet, so this event fires when a task's **planned start** (the PM-committed date) changes. A future release adds a `planned_finish` deadline field and re-binds the event to it; the event name and payload shape stay stable.
:::

## Payload shape

A `generic`-format delivery sends the flat event payload — for task events, the changed task's fields at the top level — plus a reserved `_meta` object:

```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "project": "9c8b...",
  "name": "Draft proposal",
  "status": "in_progress",
  "duration": 5,
  "assignee": "7a1f...",
  "planned_start": "2026-05-11",
  "actual_start": null,
  "actual_finish": null,
  "source": "schedule",
  "_meta": { "sequence": 42 }
}
```

The domain fields are the task as serialized for the event; the event type itself is carried in the `X-TruePPM-Event` header, not the body. (`slack`-format deliveries instead send a Slack message — `{ "text", "attachments" }` — with the same `_meta` object added.)

`_meta` is a **reserved top-level namespace for delivery metadata**, kept separate from the domain fields so it can never collide with a payload field of the same name. Today it holds one key: `_meta.sequence`, the per-subscription delivery sequence number (see [Delivery ordering and gap detection](#delivery-ordering-and-gap-detection)). It is added to **every** format, so a consumer can detect gaps from the body alone without reading the `X-TruePPM-Webhook-Sequence` header — the two always carry the same value.

## Signature verification

Every request includes an `X-TruePPM-Signature` header:

```
X-TruePPM-Signature: sha256=<hmac>
```

The HMAC is `HMAC-SHA256(secret, raw_body)` where `secret` is the value you supplied at registration and `raw_body` is the raw request bytes.

Example verification in Python:

```python
import hashlib, hmac

def verify(secret: str, body: bytes, signature: str) -> bool:
    expected = "sha256=" + hmac.new(
        secret.encode(), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

Always use a constant-time comparison to prevent timing attacks.

## Request headers

Every delivery carries these headers. Delivery metadata lives in headers; the only metadata also mirrored into the body is `_meta.sequence`, so that in-body gap detection does not require reading headers.

| Header | Value |
|--------|-------|
| `X-TruePPM-Event` | The event type (e.g. `task.updated`) |
| `X-TruePPM-Delivery` | UUID of this delivery record |
| `X-TruePPM-Signature` | `sha256=<hmac>` (see above) |
| `X-TruePPM-Webhook-Sequence` | Monotonic per-subscription sequence number (see below) |

## Delivery ordering and gap detection

Deliveries are **at-least-once** and their arrival order at your endpoint is **not guaranteed** — two events that race (e.g. `task.updated` then `task.deleted`) can arrive in either order. To let you cope with this, every delivery carries a sequence number — both in the `X-TruePPM-Webhook-Sequence` header and as `_meta.sequence` in the body (see [Payload shape](#payload-shape)):

- The number is **monotonic and contiguous per subscription**: the first delivery to a given webhook is `1`, the next `2`, and so on. It is **not** shared across webhooks — each registration has its own counter.
- It is **stable across retries**: a redelivered event keeps the same number.
- It survives delivery-history pruning — a number is never reused, even after old `WebhookDelivery` records are purged.

Consumers MAY use the sequence to:

- **Detect gaps** — if you receive sequence `7` then `9`, delivery `8` is missing (lost or still in flight). You can inspect it via the [delivery history](#delivery-history) endpoint.
- **Reorder** events that arrive out of order by buffering on the sequence.

The sequence is a **hint, not a contract**: TruePPM still guarantees only eventual, at-least-once delivery — not strict ordering or exactly-once. Use the sequence alongside idempotent handling keyed on `X-TruePPM-Delivery`.

The same value is carried in three places, always identical: the `X-TruePPM-Webhook-Sequence` header, `_meta.sequence` in the delivered body, and `sequence_number` on each record from the [delivery history](#delivery-history) endpoint.

## Delivery retries

TruePPM retries failed deliveries (non-2xx response or connection error) up to **5 times** with exponential back-off (30s, 60s, 120s, 240s, 480s). After the final failure the delivery record is marked `failed`.

## Delivery history

```http
GET /api/v1/projects/{project_id}/webhooks/{webhook_id}/deliveries/
GET /api/v1/programs/{program_id}/webhooks/{webhook_id}/deliveries/
```

Returns paginated `WebhookDelivery` records with `sequence_number`, `status`, `response_status`, `attempt_count`, and timestamps. Useful for debugging and for inspecting a delivery flagged as a gap by its sequence number.

## Disabling a webhook

Set `is_active: false` via PATCH to pause deliveries without deleting the registration:

```http
PATCH /api/v1/projects/{project_id}/webhooks/{webhook_id}/
{"is_active": false}
```

## Permissions

| Action | Minimum role |
|--------|-------------|
| List / view webhooks | Viewer |
| Create / update / delete webhooks | Admin |

The same roles apply at each scope: project Viewer/Admin for project-scoped webhooks, program Viewer/Admin for program-scoped ones.
