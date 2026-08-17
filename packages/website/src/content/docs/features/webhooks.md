---
title: Webhooks
description: Outbound HTTP callbacks for project events — integrate TruePPM with CI systems, Slack, or custom tooling.
documentedFor: "0.4"
---


:::note[Ships in 0.4]
Parts of this page are **not** in the latest release (`v0.3.0-alpha.3`) and land
with the 0.4 beta:

- the five `risk.*`, `baseline.captured`, and `comment.created` event types — the
  current release fires **14**;
- **all 19 being selectable from the Integrations settings page.** The current
  release's picker offers 11 and, worse, deletes the rest when you save an
  API-created webhook;
- the timestamped `X-TruePPM-Signature-V2` header and its verification recipe. The
  `X-TruePPM-Signature` recipe is the only one the current release sends, and 0.4
  keeps sending it too — so nothing you have already built breaks;
- **the `ping` behavior described under [Request headers](#the-ping-event).** On the
  current release a test ping skips the format renderer and carries no `_meta`, so
  a `slack`-format webhook is sent a body Slack rejects, and every Test click looks
  like a gap in your sequence counter;
- classifying a permanent `4xx` as non-retryable, and automatic deactivation of a
  persistently failing subscription. On the current release every failed delivery is
  retried on the same schedule regardless of status code, and a subscription is only
  ever deactivated by hand;
- **webhook failures reaching the dead-letter queue.** On the current release a
  permanently failed delivery leaves no operator-visible trace beyond its own
  delivery row, which purges after 7 days;
- the `secret_set` field and encryption of the signing secret at rest.

Everything else — registration, scopes, payload shape, the sequence contract, and
the delivery-history endpoint — describes the shipped feature.
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
  "events": ["task.created", "task.updated", "schedule.recalculated"],
  "format": "generic"
}
```

`events` is an array of **one or more** event type strings (see below). It is
required and may not be empty — there is no "subscribe to everything" shorthand,
because a catalog that grows would silently widen an existing subscription.

`format` selects how the payload is rendered — `generic` (default) or `slack`
(see [Payload format](#payload-format)).

### The signing secret

`secret` is **optional, and omitting it is the recommended path**. When you leave
it out, TruePPM generates a 256-bit secret and returns it in the `201` response:

```json
{
  "id": "b3f1…",
  "url": "https://hooks.example.com/trueppm",
  "events": ["task.created", "task.updated", "schedule.recalculated"],
  "format": "generic",
  "secret": "Zk8s…",
  "secret_set": true,
  "is_active": true
}
```

Three rules about that value:

- **It is returned exactly once.** The create response is the only time `secret`
  appears in any response body. Every later `GET` reports `secret_set: true` and
  nothing more. Record it when you register the webhook.
- **If you supply your own, it must be at least 32 characters.** Shorter values
  are rejected with `400`. The secret is the only thing standing between a forged
  request and an accepted delivery, so a short one is brute-forceable offline.
- **To rotate it, `PATCH` a new value.** Omitting `secret` on a `PATCH` leaves the
  stored one unchanged; sending an empty string on an existing webhook is rejected
  rather than silently disabling verification.

The secret is stored encrypted at rest (AES-128-CBC with an HMAC-SHA256 tag,
under the deployment's `INTEGRATION_ENCRYPTION_KEY`), the same mechanism used for
every other stored credential in TruePPM. There is no API path that reads it back.

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

OSS fires **19 event types** (a deliberate hard cap):

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
| `risk.opened` | A risk is created (new risks default to status OPEN) |
| `risk.escalated` | A risk's computed severity (probability × impact) increases |
| `risk.closed` | A risk transitions into status CLOSED |
| `baseline.captured` | A baseline snapshot is captured |
| `comment.created` | A comment is added to a task (every comment; no body in the payload) |

All 19 are selectable from the **Integrations** settings page as well as the API. A single PATCH that both reassigns a task and moves its date fires `task.updated` **plus** the specific events — subscribe to whichever you want.

The last four task events were added in 0.2 (available since the `0.2.0-alpha.1` pre-release).

The three `sprint.*` events were added in **0.3** so external dashboards, Slack, and CI can observe the sprint cadence. `sprint.scope_changed` fires only when a mid-sprint injection is *accepted* (it models scope that entered the commitment) — never on a silent injection or a reject.

The five `risk.*`, `baseline.*`, and `comment.created` events ship in **0.4**, extending the catalog beyond agile so external reporting and alerting tooling can observe the risk register, baseline captures, and the comment thread. `risk.escalated` fires whenever an update raises the computed severity (probability × impact); `risk.closed` fires on the transition into CLOSED (never on a move to RESOLVED or another state). A single risk update may fire both `risk.escalated` and `risk.closed`. `comment.created` fires for *every* comment (distinct from `task.mentioned`, which fires only when a comment @mentions someone) and deliberately carries **no comment body** — only the comment id, author, task context, and timestamp — so a webhook consumer never receives comment content.

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

Every delivery carries **two** signature headers. `X-TruePPM-Signature-V2` is the
recipe to implement; `X-TruePPM-Signature` is the original one, still emitted so
existing receivers keep working (see [Signature versions](#signature-versions)).

```
X-TruePPM-Signature-V2: t=1755432000,v1=<hmac>
X-TruePPM-Signature: sha256=<hmac>
```

For `X-TruePPM-Signature-V2` the HMAC is
`HMAC-SHA256(secret, "<t>.<raw_body>")` — the Unix timestamp, a literal `.`, then
the raw request bytes. `v1` names the HMAC scheme *inside* the header; the header
name carries the recipe version.

Verification is two steps, and **both are required**:

1. **Check the timestamp is recent** — reject anything more than 300 seconds from
   your own clock, reading `t` **out of this header**. This is what stops replay: `t`
   is inside the signed material, so an attacker who captured a delivery cannot move
   it forward without the secret, and an old capture is always stale. TruePPM
   deliberately does **not** send the timestamp in a separate header: an unsigned
   copy could be edited to "now" by whoever replays the capture, which would pass a
   freshness check while the HMAC still verified over the original `t` — voiding the
   whole protection.
2. **Recompute the HMAC over `"<t>.<body>"`** and compare in constant time.

```python
import hashlib, hmac, time

TOLERANCE_SECONDS = 300


def verify(secret: str, body: bytes, header: str) -> bool:
    """Verify an X-TruePPM-Signature-V2 header. Both checks are load-bearing."""
    parts = dict(p.split("=", 1) for p in header.split(","))
    timestamp, signature = parts["t"], parts["v1"]

    # Step 1 — without this the signature verifies forever and a captured
    # delivery can be replayed at any time.
    if abs(time.time() - int(timestamp)) > TOLERANCE_SECONDS:
        return False

    # Step 2 — constant-time comparison, to prevent timing attacks.
    expected = hmac.new(
        secret.encode(),
        timestamp.encode() + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

The timestamp is recomputed on **every attempt**, not once per event. A delivery
that succeeds on its final attempt — 450 seconds after the first — still carries a
fresh `t`, so a 300-second window never rejects a legitimate redelivery.

### Signature versions

| Header | Signed material | Status |
|--------|-----------------|--------|
| `X-TruePPM-Signature-V2` | `"<unix timestamp>.<raw body>"` | **Current.** Implement this. |
| `X-TruePPM-Signature` | `<raw body>` only | **Deprecated.** Still sent; scheduled for removal at 1.0. |

Both headers are sent on every delivery, computed from the same secret, so a
receiver written against either one verifies. The original recipe signs the body
alone and carries no timestamp, which means a captured delivery verifies
indefinitely — storing seen `X-TruePPM-Delivery` ids protects you against
duplicate *processing*, but nothing lets you *detect* a replay. That is why it is
deprecated rather than merely supplemented.

Migrate before 1.0: switch to `X-TruePPM-Signature-V2` and add the timestamp check.

:::caution[Fail closed once you have migrated]
Do **not** write "verify V2 if present, otherwise fall back to V1". Both headers are
computed from the same secret, so whoever replays a captured delivery can simply
*delete* the V2 and timestamp headers and present the legacy one — and a receiver
that falls back gains no replay protection at all. Once your receiver understands
V2, **reject any delivery that does not carry `X-TruePPM-Signature-V2`**. The
presence of the legacy header is never a reason to fall back, and if you verify both
a delivery is authentic only when V2 passes.
:::

## Request headers

Every delivery carries these headers. Delivery metadata lives in headers; the only metadata also mirrored into the body is `_meta.sequence`, so that in-body gap detection does not require reading headers.

| Header | Value |
|--------|-------|
| `X-TruePPM-Event` | The event type (e.g. `task.updated`), or `ping` for a test delivery |
| `X-TruePPM-Delivery` | UUID of this delivery record |
| `X-TruePPM-Signature-V2` | `t=<unix>,v1=<hmac>` (see above) — the timestamp is published only here, inside the signed material |
| `X-TruePPM-Signature` | `sha256=<hmac>` — deprecated, see [Signature versions](#signature-versions) |
| `X-TruePPM-Webhook-Sequence` | Monotonic per-subscription sequence number (see below) |

### The `ping` event

`ping` is a **reserved, non-domain event type**. No subscription can select it and
no project mutation emits it — it is sent only when an admin clicks **Test** on a
webhook, or `POST`s to the test endpoint. It is otherwise an ordinary delivery: it
renders through the subscription's format, is signed identically, and consumes a
sequence number with a matching `_meta.sequence`, so a test click never shows up
as a gap in your counter. Handle it as a no-op, or use it to confirm your endpoint
is reachable.

## Delivery ordering and gap detection

Deliveries are **at-least-once** and their arrival order at your endpoint is **not guaranteed** — two events that race (e.g. `task.updated` then `task.deleted`) can arrive in either order. To let you cope with this, every delivery carries a sequence number — both in the `X-TruePPM-Webhook-Sequence` header and as `_meta.sequence` in the body (see [Payload shape](#payload-shape)):

- The number is **monotonic and contiguous per subscription**: the first delivery to a given webhook is `1`, the next `2`, and so on. It is **not** shared across webhooks — each registration has its own counter.
- It is **stable across retries**: a redelivered event keeps the same number.
- It survives delivery-history pruning — a number is never reused, even after old `WebhookDelivery` records are purged.

Consumers MAY use the sequence to:

- **Detect gaps** — if you receive sequence `7` then `9`, delivery `8` is missing (lost or still in flight). You can inspect it via the [delivery history](#delivery-history) endpoint.
- **Reorder** events that arrive out of order by buffering on the sequence.

The sequence is a **hint, not a contract**: TruePPM still guarantees only eventual, at-least-once delivery — not strict ordering or exactly-once. Use the sequence alongside idempotent handling keyed on `X-TruePPM-Delivery`.

The same value is carried in three places, always identical: the `X-TruePPM-Webhook-Sequence` header, `_meta.sequence` in the delivered body, and `sequence_number` on each record from the [delivery history](#delivery-history) endpoint. That holds for **every** delivery, including a [`ping`](#the-ping-event).

## Delivery retries

A failed delivery is attempted up to **5 times** with exponential back-off. The
four back-off waits are 30s, 60s, 120s, and 240s, so the attempts land at **0, 30,
90, 210, and 450 seconds** — a total span of **7 minutes 30 seconds**. After the
fifth attempt the delivery record is marked `failed`.

**Not every failure is retried.** A response in the 4xx range other than 408, 425,
and 429 is a *permanent* client error: the request itself is wrong, so replaying
identical bytes cannot succeed. Those fail after a single attempt.

| Receiver response | Behavior |
|---|---|
| `2xx` | Success. Resets the subscription's failure counter. |
| `408`, `425`, `429` | Retried — the receiver is asking you to come back. |
| Other `4xx` (e.g. `400`, `401`, `403`, `404`, `410`) | **Permanent.** One attempt, then `failed`. |
| `5xx`, connection error, timeout | Retried on the back-off schedule above. |

A delivery has **no replay path** once it is terminal: after the back-off window
is exhausted the event is not recoverable, and terminal delivery records are
purged after `TRUEPPM_WEBHOOK_RETENTION_DAYS` (default 7). **A receiver down for
more than 7.5 minutes loses the events fired during the outage.** Plan a
reconciliation read against the API for anything you cannot afford to miss.

## Automatic deactivation

A webhook that keeps failing terminally is deactivated automatically after **5
consecutive terminal failures**, and stops receiving deliveries. This bounds the
damage from a receiver that has been decommissioned or has had its URL revoked —
before it, a revoked endpoint answering `410` was retried for every matching event
indefinitely.

Two kinds of terminal failure are recorded but deliberately **not** counted toward
that threshold, because neither is evidence about the receiver's health under
production traffic:

- **A failed test ping.** A ping is a human probe. Counting it would make your own
  debugging loop the trip wire — five clicks on **Test** against a broken receiver
  would deactivate the subscription.
- **A delivery refused by the SSRF egress guard.** The guard re-resolves the
  receiver's hostname on every delivery, so counting it would let whoever controls
  that name's resolution deactivate the subscription. The delivery is still refused
  and recorded; it just does not move the counter.

Each webhook reports its own delivery health:

| Field | Meaning |
|---|---|
| `consecutive_failures` | Terminal failures since the last success. Any success resets it to `0`. |
| `last_failure_at`, `last_failure_reason` | When the most recent terminal failure happened, and why. |
| `disabled_at`, `disabled_reason` | Set **only** when the automatic guard deactivated the subscription. A webhook an admin paused by hand has `disabled_at: null`. |

All five are read-only. To resume deliveries, fix the receiver and re-enable the
webhook — `PATCH {"is_active": true}` clears the failure record in the same write,
so the guard starts counting again from zero.

For operators: a terminally failed delivery is also recorded in the
[dead-letter queue](/administration/dead-letter-alerting/), which is where alerting
and the parked-task metric live. Note that once a subscription is deactivated its
skipped deliveries are **not** recorded there — so the dead-letter stream for that
webhook goes quiet at the moment it is deactivated. The record for the failure that
crossed the threshold says so explicitly, and it is the last one you will see: do not
read the silence that follows as a recovery.

## Delivery history

```http
GET /api/v1/projects/{project_id}/webhooks/{webhook_id}/deliveries/
GET /api/v1/programs/{program_id}/webhooks/{webhook_id}/deliveries/
```

**Requires Admin** on the project or program (see [Permissions](#permissions)).

Returns `WebhookDelivery` records with `sequence_number`, `status`, `response_status`, `attempt_count`, and timestamps. Useful for debugging and for inspecting a delivery flagged as a gap by its sequence number.

This is also how you find out what a **test ping** actually did. `POST
.../webhooks/{id}/test/` answers `202` with a `delivery_id` — that acknowledges the
*enqueue*, not the receiver's answer. Read the matching delivery record back to see
the `status` and `response_status` your endpoint returned.

The delivery log grows without bound, so it is **cursor**-paginated rather than
page-numbered: the envelope is `{next, previous, results}` with **no `count`**.
Follow `next` until it is `null`. See [Pagination](/api/reference/#pagination).

## Disabling a webhook

Set `is_active: false` via PATCH to pause deliveries without deleting the registration. This is the manual counterpart to [automatic deactivation](#automatic-deactivation) — a hand-paused webhook leaves `disabled_at` null, so the two are distinguishable:

```http
PATCH /api/v1/projects/{project_id}/webhooks/{webhook_id}/
{"is_active": false}
```

## Permissions

| Action | Minimum role |
|--------|-------------|
| List / view webhooks | Viewer |
| Create / update / delete webhooks | Admin |
| Send a test ping | Admin |
| **Read the delivery history** | **Admin** |

The delivery history is Admin-only, not Viewer: each record carries the full event
payload that was sent, which is disclosure beyond plain project membership. A
Viewer following the first row of this table can list webhooks but receives `403`
from the `deliveries` endpoint.

The same roles apply at each scope: project Viewer/Admin for project-scoped webhooks, program Viewer/Admin for program-scoped ones.
