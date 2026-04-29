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
