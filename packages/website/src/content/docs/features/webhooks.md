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

## Delivery retries

TruePPM retries failed deliveries (non-2xx response or connection error) up to **3 times** with exponential back-off (10s, 60s, 300s). After 3 failures the delivery record is marked `failed`.

## Delivery history

```http
GET /api/v1/projects/{project_id}/webhooks/{webhook_id}/deliveries/
```

Returns paginated `WebhookDelivery` records with `status`, `response_status`, `attempt_count`, and timestamps. Useful for debugging.

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
