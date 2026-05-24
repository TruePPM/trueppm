# ADR-0019: Outbound Webhooks for Project State Changes

## Status
Accepted

## Context
External systems (CI/CD pipelines, Slack bots, BI dashboards, ServiceNow) need to
react to TruePPM project events in near-real-time. Today the only push mechanism is
WebSocket broadcast to connected browsers. There is no way for a headless system to
subscribe to project mutations without polling the API.

Issue #13 calls for outbound webhooks with HMAC-SHA256 signatures, exponential
backoff retry, and per-project scoping. VoC panel score: 5.2/10 — this is an
integrator/developer feature, not a direct end-user feature. Marcus (PMO Director,
8/10) considers it table stakes for enterprise adoption.

The codebase already has 25+ `transaction.on_commit` callbacks that fire
`broadcast_board_event()` after every mutation. Webhook dispatch must follow the
same discipline: enqueue delivery **after** the transaction commits, never inside it.

## Decision

### New Django app: `trueppm_api.apps.webhooks`

**Models** (plain `models.Model`, NOT `VersionedModel` — webhooks are server-side
infrastructure, never synced to mobile):

#### `Webhook`
| Field | Type | Notes |
|-------|------|-------|
| `id` | UUIDField PK | |
| `project` | FK → Project (CASCADE) | Per-project scope |
| `url` | URLField(max_length=2048) | Delivery target |
| `secret` | CharField(max_length=255) | HMAC-SHA256 signing key, stored encrypted at rest via `django-fernet-fields` or plain text in OSS (no PII) |
| `events` | ArrayField(CharField) | e.g. `["task.created", "task.updated"]` |
| `is_active` | BooleanField(default=True) | Soft disable without deleting |
| `created_at` | DateTimeField(auto_now_add) | |
| `created_by` | FK → User (SET_NULL, nullable) | Audit |

Index: `(project, is_active)` for the dispatch query.

#### `WebhookDelivery`
| Field | Type | Notes |
|-------|------|-------|
| `id` | UUIDField PK | |
| `webhook` | FK → Webhook (CASCADE) | |
| `event_type` | CharField | e.g. `task.created` |
| `payload` | JSONField | Full event payload |
| `status` | CharField choices: `pending`, `success`, `failed` | |
| `response_status` | SmallIntegerField(nullable) | HTTP status from target |
| `attempt_count` | SmallIntegerField(default=0) | |
| `created_at` | DateTimeField(auto_now_add) | |
| `completed_at` | DateTimeField(nullable) | |

Index: `(webhook, created_at)` for the delivery log list view.
Retention: deliveries older than 7 days purged by a nightly Celery beat task.

### Event types
| Event | Trigger point | Payload includes |
|-------|--------------|-----------------|
| `task.created` | `TaskViewSet.perform_create` | task ID, name, project, assignee, status, duration |
| `task.updated` | `TaskViewSet.perform_update` | task ID, changed fields (including assignee) |
| `task.deleted` | `TaskViewSet.perform_destroy` | task ID, project |
| `dependency.created` | `DependencyViewSet.perform_create` | dep ID, predecessor, successor, type, lag |
| `dependency.deleted` | `DependencyViewSet.perform_destroy` | dep ID |
| `schedule.recalculated` | `recalculate_schedule` Celery task (on success) | project ID, project_finish, critical_path |
| `project.created` | `ProjectViewSet.perform_create` | project ID, name, start_date |

### Delivery mechanism

1. At each existing `transaction.on_commit` callback (where `broadcast_board_event`
   already fires), also call `dispatch_webhooks(project_id, event_type, payload)`.
2. `dispatch_webhooks` queries `Webhook.objects.filter(project_id=..., is_active=True,
   events__contains=[event_type])` and enqueues one `deliver_webhook.delay(delivery_id)`
   per matching subscription.
3. `deliver_webhook` Celery task: POST to the URL with JSON body, `X-TruePPM-Signature`
   header (HMAC-SHA256 of body using webhook secret), `Content-Type: application/json`.
4. Retry with exponential backoff: 30s, 60s, 120s, 240s, 480s (5 attempts max).
   After final failure, mark `WebhookDelivery.status = "failed"`.
5. Success = HTTP 2xx response. Any other status = retry.

### Signature format
```
X-TruePPM-Signature: sha256=<hex digest of HMAC-SHA256(secret, request body)>
```

### API endpoints

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| GET | `/api/v1/projects/{pk}/webhooks/` | Viewer+ | List webhooks |
| POST | `/api/v1/projects/{pk}/webhooks/` | Admin+ | Create webhook |
| GET | `/api/v1/projects/{pk}/webhooks/{id}/` | Viewer+ | Retrieve webhook |
| PATCH | `/api/v1/projects/{pk}/webhooks/{id}/` | Admin+ | Update webhook |
| DELETE | `/api/v1/projects/{pk}/webhooks/{id}/` | Admin+ | Delete webhook |
| GET | `/api/v1/projects/{pk}/webhooks/{id}/deliveries/` | Admin+ | List recent deliveries |
| POST | `/api/v1/projects/{pk}/webhooks/{id}/test/` | Admin+ | Send test ping event |

### RBAC
- Webhook management (create/update/delete) requires `Admin` role on the project.
  Rationale: webhooks send potentially sensitive project data to external URLs.
  Only project admins should control where data flows.
- Webhook listing and delivery log requires `Viewer` or above (read-only visibility).
- The `secret` field is write-only in serializer output (never returned in GET).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. Django signals → webhook receiver** | Leverages existing signal infra | Signals fire inside the transaction; would need `on_commit` wrapper anyway. Also misses events not backed by signals (dependency CRUD, schedule completion) |
| **B. Redis Streams event bus** | Durable, replayable | Adds operational complexity; overkill for webhook fan-out; not in the tech stack |
| **C. on_commit dispatch (chosen)** | Piggybacks on existing pattern; fires only after successful commit; covers all mutation types | Requires touching each viewset's `on_commit` callback |
| **D. Middleware-based capture** | Zero changes to views | Can't reliably capture the semantic event type or structured payload; too generic |

Option C wins: it is the most consistent with the existing `broadcast_board_event`
pattern, guarantees delivery only fires after commit, and gives full control over
the payload shape per event type.

## Consequences
- **Easier**: External systems can subscribe to project events without polling.
  Enables Slack/Teams notifications, CI/CD triggers, BI pipeline feeds.
- **Easier**: Enterprise can extend with portfolio-wide webhooks by adding a
  nullable `portfolio_id` FK to `Webhook` — the dispatch query just adds an OR
  clause.
- **Harder**: Each new mutation type requires adding a `dispatch_webhooks` call.
  Mitigated by the helper function making it a one-liner.
- **Risk**: A webhook target that is slow or down could cause delivery backlog.
  Mitigated by: (a) async Celery delivery, (b) max 5 retries with backoff,
  (c) `is_active` auto-disable after N consecutive failures (future enhancement).

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api
- Migration required: yes (new `Webhook` and `WebhookDelivery` tables)
- API changes: yes (new `/webhooks/` endpoints under each project)
- OSS or Enterprise: OSS

## Amendment (#664, 0.4): per-subscription delivery sequence numbers

`WebhookDelivery` guarantees at-least-once delivery but not ordering — two racing
events (`task.updated` then `task.deleted`) can arrive in either order. This
amendment adds a per-subscription monotonic sequence number so consumers can
detect gaps and reorder. It is the outbound counterpart to inbound sync ordering.

### Decision

- **Allocation:** a `delivery_sequence` `BigIntegerField` counter on `Webhook`
  (the subscription), incremented under `select_for_update` inside an explicit
  `transaction.atomic()` and stamped onto `WebhookDelivery.sequence_number` on
  INSERT. The explicit transaction is required because dispatch runs from a
  `transaction.on_commit` callback (autocommit), where a bare `F()+1` + read-back
  would race. Allocation happens once at row creation, so the number is stable
  across the Celery retry chain.
- **Counter lives on the subscription, not derived from deliveries.** The
  retention purge (ADR-0081) deletes terminal `WebhookDelivery` rows; deriving the
  next value from `max(sequence_number)` would reuse numbers after a purge and
  corrupt gap detection. The counter therefore yields *contiguous* numbers — a gap
  at the consumer signals a genuinely lost event.
- **Transport: header only — `X-TruePPM-Webhook-Sequence`.** The sequence is
  *delivery* metadata, so it joins the existing `X-TruePPM-Event` /
  `X-TruePPM-Delivery` / `X-TruePPM-Signature` headers. The body stays the raw
  payload — this ADR's original "metadata in headers, body is the event" split is
  preserved.
  - **Body envelope explicitly declined.** Issue #664 proposed a body envelope,
    but wrapping the body would (a) reverse the raw-payload decision above, (b)
    break every existing consumer's body parsing and HMAC validation, and (c) be a
    one-way contract door opened pre-1.0. Header-only is purely additive. If a
    concrete body-only/no-code consumer ever needs it, the non-breaking path is an
    additive reserved `_meta` key — not a full envelope.
- **Replay out of scope.** #664 referenced a "replay endpoint" that does not
  exist. Consumers inspect a flagged gap via the existing
  `GET /webhooks/{id}/deliveries/` endpoint (now exposing `sequence_number`).
  Automated redelivery is a separate future concern.
- **Contract strength:** the sequence is a *hint*. Delivery remains eventual,
  at-least-once — not strict-order or exactly-once. Consumers pair it with
  idempotent handling keyed on `X-TruePPM-Delivery`.

### Durable Execution
1. Broker-down behaviour: unchanged — dispatch still creates the delivery row
   (now with a sequence) inside `on_commit`; a failed `.delay()` leaves the row
   PENDING for the drain. Sequence allocation is part of the committed row, so a
   re-dispatched delivery keeps its number.
2. Drain task: reuses the existing `webhooks.drain_webhook_queue` — semantics
   unchanged (it re-enqueues PENDING rows; it never creates rows, so it never
   allocates sequences).
3. Orphan window: unchanged (5 min) — N/A to sequencing.
4. Service layer: allocation is encapsulated in `_next_delivery_sequence()` and
   invoked from `WebhookDelivery.save()`, so every creation path (dispatch,
   test ping) is sequenced consistently without a new dispatch path.
5. API response on best-effort dispatch: unchanged — N/A (no new endpoint).
6. Outbox cleanup: unchanged (ADR-0081 purge). The amendment hardens against it
   by keeping the counter on the surviving `Webhook` row.
7. Idempotency: the sequence is allocated only when `_state.adding` and not
   already set, so retries (which re-`save()` the same row) never re-number it.
8. Dead-letter / failure handling: unchanged — a permanently failed delivery
   retains its allocated sequence, so a consumer still sees the gap.
