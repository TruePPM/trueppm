---
title: Webhooks
description: Outbound HTTP callbacks for project events — integrate TruePPM with CI systems, Slack, or custom tooling.
---

Webhooks let you subscribe to TruePPM project events and receive an HTTP POST to a URL you control when those events occur. Common uses: posting notifications to Slack, triggering a CI pipeline when a milestone is resolved, or syncing changes to an external system.

## Registering a webhook

Webhooks are scoped to a project. Register one via the API or (once the Integrations UI lands) from the project settings page.

```http
POST /api/v1/projects/{project_id}/webhooks/
Content-Type: application/json

{
  "url": "https://hooks.example.com/trueppm",
  "secret": "your-shared-secret",
  "events": ["task.created", "task.updated", "schedule.recalculated"]
}
```

`events` is an array of one or more event type strings (see below). Omit `events` to subscribe to all event types.

**Permissions**: requires Admin role (role ≥ 4) on the project.

## Event types

| Event | When fired |
|-------|-----------|
| `task.created` | A task is created |
| `task.updated` | A task field is changed |
| `task.deleted` | A task is deleted |
| `dependency.created` | A task link (FS/SS/FF/SF) is created |
| `dependency.deleted` | A task link is deleted |
| `schedule.recalculated` | The CPM scheduler completes a recalculation |
| `project.created` | A new project is created in the organization |

## Payload shape

Every delivery sends a JSON body:

```json
{
  "event": "task.updated",
  "project_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "timestamp": "2026-05-11T14:30:00Z",
  "data": { ... }
}
```

`data` contains the serialized resource that changed. For task events this is the full task object as returned by `GET /api/v1/tasks/{id}/`.

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

Every delivery carries these headers. All delivery metadata lives in headers; the body is the event payload only.

| Header | Value |
|--------|-------|
| `X-TruePPM-Event` | The event type (e.g. `task.updated`) |
| `X-TruePPM-Delivery` | UUID of this delivery record |
| `X-TruePPM-Signature` | `sha256=<hmac>` (see above) |
| `X-TruePPM-Webhook-Sequence` | Monotonic per-subscription sequence number (see below) |

## Delivery ordering and gap detection

Deliveries are **at-least-once** and their arrival order at your endpoint is **not guaranteed** — two events that race (e.g. `task.updated` then `task.deleted`) can arrive in either order. To let you cope with this, every delivery carries a sequence number in the `X-TruePPM-Webhook-Sequence` header:

- The number is **monotonic and contiguous per subscription**: the first delivery to a given webhook is `1`, the next `2`, and so on. It is **not** shared across webhooks — each registration has its own counter.
- It is **stable across retries**: a redelivered event keeps the same number.
- It survives delivery-history pruning — a number is never reused, even after old `WebhookDelivery` records are purged.

Consumers MAY use the sequence to:

- **Detect gaps** — if you receive sequence `7` then `9`, delivery `8` is missing (lost or still in flight). You can inspect it via the [delivery history](#delivery-history) endpoint.
- **Reorder** events that arrive out of order by buffering on the sequence.

The sequence is a **hint, not a contract**: TruePPM still guarantees only eventual, at-least-once delivery — not strict ordering or exactly-once. Use the sequence alongside idempotent handling keyed on `X-TruePPM-Delivery`.

The same value is also returned as `sequence_number` on each record from the [delivery history](#delivery-history) endpoint.

## Delivery retries

TruePPM retries failed deliveries (non-2xx response or connection error) up to **3 times** with exponential back-off (10s, 60s, 300s). After 3 failures the delivery record is marked `failed`.

## Delivery history

```http
GET /api/v1/projects/{project_id}/webhooks/{webhook_id}/deliveries/
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
