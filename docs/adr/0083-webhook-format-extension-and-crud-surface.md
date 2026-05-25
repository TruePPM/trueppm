# ADR-0083: Webhook Format Extension, New Task Events, and Project/Program CRUD Surface

## Status
Accepted

## Context

Issue #638 extends the existing outbound webhook system (ADR-0019) with
provider-specific payload rendering (a Slack renderer alongside the existing
generic envelope) and four new task event types. Issue #600 (pulled forward
into 0.2 by product decision) replaces the read-only "Manage via API" affordance
on the Project/Program → Settings → Integrations pages with real CRUD UI for
webhooks and API tokens.

The provider-registry extension points (`OUTGOING_CHANNEL_PROVIDERS`) already
exist, scaffolded empty, per ADR-0049. The `Webhook` and `ApiToken` models
already carry the polymorphic project-XOR-program scope per ADR-0076. The
project-scope `WebhookViewSet` and `ProjectApiTokenViewSet` already exist with
full CRUD, one-time-reveal token creation, and the `transaction.on_commit`
dispatch discipline. What is missing: the `format` field + renderers, the four
events, the program-scope CRUD endpoints, and all frontend CRUD UI.

**P3M layer:** Programs and Projects (OSS). Webhooks and API tokens are how a
single PM/team wires their program into their own stack. Workspace-scoped
integration management is Enterprise (ADR-0076) and is explicitly **not** built
here.

## Decision

### 1. `Webhook.format` field + provider rendering

- Add `format = CharField(max_length=32, default="generic")` to `Webhook`.
  Validated at **write time** in the serializer against
  `OUTGOING_CHANNEL_PROVIDERS.keys()` — not a `TextChoices` list, so Enterprise
  can register `slack_app`/`teams` without an OSS migration (ADR-0049).
- Register two OSS providers in `OUTGOING_CHANNEL_PROVIDERS` at the
  `integrations` `AppConfig.ready()`, mirroring the existing
  `OSS_TASK_LINK_PROVIDERS` registration loop:
  - `generic` — returns the event payload unchanged (today's behavior, so
    existing rows that default to `generic` are byte-for-byte unaffected).
  - `slack` — renders the Slack-attachment JSON shape. Discord and Mattermost
    incoming-webhook URLs accept the Slack shape de-facto, so one renderer
    covers all three.
- `dispatch_webhooks()` renders **per webhook** (each subscription may have a
  different format): `provider = OUTGOING_CHANNEL_PROVIDERS.get(webhook.format)`,
  then `rendered = provider().render(event) if provider else payload`. The
  rendered dict is stored on that `WebhookDelivery.payload`.
- `deliver_webhook` is **unchanged** — it already POSTs `delivery.payload` as
  the raw body and signs it with HMAC-SHA256. The sequence number stays in the
  `X-TruePPM-Webhook-Sequence` header; no body envelope (ADR-0019 / #664).

The `render(event)` contract takes a small `OutgoingChannelEvent` dataclass
(`event_type`, `project_id`, `payload`) so renderers have the event name without
re-parsing the payload. This matches the existing `OutgoingChannelProvider.render`
ABC (single `render` method); the provider does **not** POST — `deliver_webhook`
owns transport.

### 2. Four new event types (hard cap → 11)

Add to `WebhookEventType`: `task.assigned`, `task.assignee_changed`,
`task.mentioned`, `task.due_date_changed`. Total OSS events becomes **11 — a
hard cap**. A module-level `OSS_WEBHOOK_EVENT_CAP = 11` constant plus a test that
asserts `len(ALL_WEBHOOK_EVENTS) == OSS_WEBHOOK_EVENT_CAP` and pins the exact set
makes a 12th addition fail loudly; the test docstring points back to this ADR
(a 12th event requires its own ADR — this is the gate against the
per-customer event proliferation that is the Enterprise upsell).

**Event firing hook points** (all follow the existing
`_task_webhook_payload` + `transaction.on_commit(lambda: _dispatch_webhooks(...))`
pattern in `apps/projects/views.py`):

| Event | Hook point | Trigger |
|---|---|---|
| `task.assigned` | `TaskViewSet.perform_update` + `accept_suggestion` action | assignee transitions `None → user` |
| `task.assignee_changed` | `TaskViewSet.perform_update` | assignee transitions `userA → userB` (both non-null) |
| `task.due_date_changed` | `TaskViewSet.perform_update` | `planned_start` changes (see ADR-decision below; #690 rebinds to a real deadline field) |
| `task.mentioned` | comment viewset `perform_create`, after `create_mention_notifications` | a new comment mentions a user |

`perform_update` snapshots `old_assignee_id` / `old_planned_start` from
`serializer.instance` **before** `serializer.save()`, compares after, and adds
the matching `on_commit` dispatch beside the existing `task.updated` one. A
single PATCH that both reassigns and moves the date fires `task.updated` plus the
specific events — consumers subscribe to whichever they want.

**`task.due_date_changed` binds to `planned_start`.** `Task` has no due-date
field; `planned_start` is the PM-committed date (the `plannedStart`-is-the-
commitment convention). #690 (milestone 0.3) adds a real `planned_finish`
deadline field and re-binds this event to it — a documented future behavior
change to the event's trigger (the name/contract is stable).

### 3. Program-scope CRUD endpoints

The project-scope viewsets exist; the program-scope ones do not. Build:

- `ProgramWebhookViewSet` registered at
  `programs/(?P<program_pk>[^/.]+)/webhooks` (in `apps/webhooks/urls.py`,
  `DefaultRouter`, mirroring the project registration). Scope-aware
  `get_queryset` (`program_id=program_pk`) and `perform_create`
  (`program=`, not `project=`).
- `ProgramApiTokenViewSet` + audit view at
  `programs/<program_pk>/api-tokens/` and `.../api-token-audit/` (in
  `apps/projects/urls.py`, manual `path()` entries).
- RBAC ladder: reads → `IsProgramMember`; mutations (create/revoke/test) →
  `IsProgramAdmin`. Both classes exist in `apps/access/permissions.py` and read
  `program_pk` from `view.kwargs`.

Implemented by extracting the shared CRUD body into a scope-agnostic mixin the
project and program viewsets both subclass, parameterized by which URL kwarg /
permission class / FK field applies — so the one-time-reveal, HMAC secret
write-only, and audit logic are not duplicated.

### 4. Frontend CRUD UI (project + program)

Replace the inert "Manage via API (UI coming in 0.3)" affordance on
`ProjectIntegrationsPage` and `ProgramIntegrationsPage` with real CRUD per
ux-design. New TanStack Query hooks (`useWebhooks`/`useCreateWebhook`/
`useUpdateWebhook`/`useDeleteWebhook`/`useTestWebhook`,
`useApiTokens`/`useCreateApiToken`/`useRevokeApiToken`), scope-parameterized
(project vs program) so one hook set serves both pages. One-time token reveal
modal: the raw token is shown exactly once from the create response and never
retrievable. Format picker shows only `slack` + `generic` as selectable; other
formats render disabled ("Enterprise"). The event picker is built around the
**real 11 events** — the mock's Sprint/Schedule/Risk events do not exist and are
not shown.

**No workspace-scope page** is created (ADR-0076: workspace integration
management is Enterprise). The mock's `scope="workspace"` chrome is ignored.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Render in `deliver_webhook` at delivery time (not dispatch) | Renderer sees latest provider code on retry | Changes `deliver_webhook` (issue says keep it unchanged); re-renders on every retry; payload not auditable on the delivery row |
| **Render at dispatch, store rendered payload per delivery** (chosen) | `deliver_webhook` unchanged; delivery row is the audit record of exactly what was sent; per-webhook format honored in the fan-out | Rendered payload frozen at dispatch (acceptable — events are immutable facts) |
| `format` as `TextChoices` | DB-level validation, admin dropdown | Enterprise adding a provider needs an OSS migration — violates ADR-0049 |
| Separate Program viewsets duplicating CRUD | Simple | Duplicates one-time-reveal + secret-handling + audit logic; drift risk |
| `task.due_date_changed` → `early_finish` (CPM) | Closer to "finish" semantic | Fires on every recalculation (noisy), bypasses save/signals, not PM-intentional |

## Consequences

- **Easier:** Slack/Discord/Mattermost integration with zero consumer-side
  parsing; assignee-change events from day one (David's VoC blocker); a clear
  Enterprise extension seam for richer providers.
- **Harder:** The 11-event cap is now load-bearing — new events require an ADR.
  `task.due_date_changed` carries a known future trigger change (#690), which
  must be communicated to consumers.
- **Risks:** A program-scope and project-scope webhook can both match one event
  (already handled by the existing `Q` union in `dispatch_webhooks` — a project
  event reaches both its project webhooks and its program's webhooks). The
  per-webhook render must not assume project scope.

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** api (webhooks, integrations, projects), web
- **Migration required:** yes — `Webhook.format` add-column, `default="generic"`
  backfills existing rows in the same DDL (no separate data migration; no
  NOT NULL-without-default risk). New `WebhookEventType` values are not a schema
  change (the `events`/`event_type` columns are `CharField(max_length=30)`; all
  four new values fit).
- **API changes:** yes — `format` field on the Webhook serializer; new
  program-scope webhook + api-token routes; four new event-type enum values.
- **OSS or Enterprise:** OSS. `grep -r "trueppm_enterprise" packages/` stays
  zero; providers register via `AppConfig.ready()` only.

### Durable Execution
1. **Broker-down behaviour:** Unchanged from ADR-0019. `dispatch_webhooks`
   writes the `WebhookDelivery` row in the request transaction and attempts
   `deliver_webhook.delay()` inside `transaction.on_commit`, swallowing
   `_BROKER_ERRORS`. Rendering happens before the row write, in-process, so a
   broker outage leaves a PENDING row with the already-rendered payload.
2. **Drain task:** Reuses the existing `drain_webhook_queue` (Beat, 30s,
   idempotent) — semantics are identical; the new events and rendered payloads
   are ordinary `WebhookDelivery` rows.
3. **Orphan window:** Unchanged — 5 minutes (`_DRAIN_ORPHAN_MINUTES`).
4. **Service layer:** `apps/webhooks/dispatch.py::dispatch_webhooks` (existing).
   New event call sites go through the existing `_dispatch_webhooks` trampoline
   in `apps/projects/views.py`.
5. **API response on best-effort dispatch:** N/A for the event-firing paths
   (they ride existing task PATCH/comment-create responses). Webhook/token CRUD
   are synchronous CRUD responses; token create returns the raw token once.
6. **Outbox cleanup:** Unchanged — `purge_old_deliveries` (ADR-0081), terminal
   rows only, `TRUEPPM_WEBHOOK_RETENTION_DAYS` (default 7). `ApiTokenAuditEntry`
   is excluded from purge (compliance evidence).
7. **Idempotency:** `deliver_webhook` is unchanged and already idempotent (keyed
   on the delivery row PK; sequence stamped on INSERT, stable across retries).
   Event firing is at-least-once; a duplicate task PATCH that does not actually
   change the assignee/date does **not** fire the specific event (the
   before/after snapshot guards it).
8. **Dead-letter / failure handling:** Unchanged — `deliver_webhook` retries
   with exponential backoff up to 5 attempts, then marks the delivery `FAILED`
   (surfaced in the delivery log UI). No new DLQ.
