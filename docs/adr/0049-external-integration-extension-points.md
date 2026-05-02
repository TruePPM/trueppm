# ADR-0049: External Integration Extension Points (Task Links, Outgoing Channels, Notification Channels)

## Status
Accepted

## Context

Issue [trueppm/trueppm#302](https://gitlab.com/trueppm/trueppm/-/work_items/302) (OSS, milestone 0.2) and its
Enterprise companion [trueppm/trueppm-enterprise#57](https://gitlab.com/trueppm/trueppm-enterprise/-/work_items/57)
add three external-integration surfaces:

1. **Git-aware tasks** — paste a GitLab/GitHub URL on a task, see a preview and an on-demand
   status badge fetched with the user's PAT.
2. **Outgoing event channels** — post task events (created, status change, assignment, mention,
   due-date change) to a Slack-compatible webhook URL.
3. **Notification channels** — per-user, per-event-type opt-in for email (and later in-app, Slack
   DM, Teams, SMS).

The OSS slice covers the floor; the Enterprise tier (trueppm-enterprise#57) layers webhook ingest,
bidirectional sync, Slack App with slash commands, email-in gateway, portfolio digests, multi-provider
mapping rules, and an immutable audit trail on top. **Enterprise must register against stable shapes
in OSS — it cannot fork them or it will diverge on every release.** That is the motivating problem
for this ADR.

### Persona resonance — VoC panel

Scored against the rubric in `.claude/personas.md` (1–10, severity-tagged):

| Persona | P3M layer | Score | Tag | Headline |
|---|---|---|---|---|
| Alex (Scrum Master) | Operations | **8** — Champion | 🟢 | Top-three eval criterion satisfied. Will push for bidirectional sync next (Enterprise). |
| Sarah (PM) | Programs/Projects | 7 | 🟢 | Email is the win. Slack/git lukewarm for non-software Sarahs — keep opt-in. |
| Priya (Team Member) | Operations | 6 | 🟡 | Opt-in defaults save it. Aggressive defaults would lose her. |
| Janet (Executive Sponsor) | Senior Leadership | 5 | 🟡 | Wants portfolio digest, not per-task pings — Enterprise-tier need. |
| Marcus (PMO Director) | Portfolios | 5 | 🟡 | Checklist tick. Governance/audit is what he buys — Enterprise. |
| David (Resource Manager) | Portfolios | 4 | 🟡 | Doesn't solve his core problem unless allocation events ship. **`task.assignee_changed` does ship in scope** — moves him to ~6 in practice. |

**Target-layer average** (Operations + Programs/Projects, the OSS slice's audience): **7.0/10**.
**Cross-layer average** (all six personas): 5.8/10 — informational, not the decision figure for an OSS-targeted feature.

**Heuristic applied** (extending `personas.md` rubric to use stratified scoring + champion threshold):

- The relevant signal for an OSS feature is the average across personas at the **target P3M layer**, not all six. Non-target personas scoring low is the resonance rule working as intended, not a problem to be averaged into the headline. The cross-layer figure is informational.
- A single target-layer persona at score ≥ 8 is a **champion** — sufficient to justify shipping when no 🔴 blockers exist. A 7 is "strong adopt-with-conditions" — sufficient when paired with another target-layer ≥ 6.
- 🔴 blockers still override regardless of scores.

For this slice: Alex (Operations) is the champion at 8; Sarah (Programs/Projects) at 7 with Priya (Operations) at 6 confirms the layer adoption. **Verdict: ship with confidence.**

### 🔴 Blockers — addressed in scope below

The original panel surfaced four blockers; all are resolved by the design in this ADR:

1. **Notification defaults must be tight** (Priya 🔴) — per-event-type opt-in; default seeded only for own-task events. Encoded in §4 (`apps/notifications/`).
2. **Outgoing webhook URL is a secret** (Marcus 🔴) — project-admin RBAC; reuses existing `apps/webhooks/` audit (`WebhookDelivery`). Encoded in §2.
3. **`task.assignee_changed` ships day one, not v0.3** (David 🔴) — listed in the four new event types in §2; lifts his score from 4 to ~6 in practice.
4. **Bidirectional sync is the upgrade path** (Alex's soft 🟡 expectation) — explicit in §5 boundary table. Sets honest expectations.

**P3M layer**: Programs and Projects (OSS) for the slice this ADR governs. Portfolio-level digests and cross-project event routing are explicitly out of scope and live in trueppm-enterprise#57.

### Existing infrastructure to reuse (not duplicate)

A focused codebase scan turned up two facts that change the scope from what trueppm/trueppm#302
originally proposed:

- **Outbound webhooks already exist in OSS** at `packages/api/src/trueppm_api/apps/webhooks/`.
  `Webhook` (project-scoped, with `url`, `secret`, `events: ArrayField`, `is_active`),
  `WebhookEventType` (7 events: `task.created`, `task.updated`, `task.deleted`,
  `dependency.created`, `dependency.deleted`, `schedule.recalculated`, `project.created`),
  `WebhookDelivery` (status tracking, retry count), and a Celery `deliver_webhook` task with
  HMAC-SHA256 signing and **5-retry exponential backoff**. Dispatch goes through
  `webhooks/dispatch.py::dispatch_webhooks()` deferred via `transaction.on_commit()`, with a
  30-second drain task in Beat. **OSS already has retry/backoff** — issue #302's claim that
  retry is Enterprise-only is incorrect and is updated below.
- **Outbox / `services.py` pattern is real and documented** in
  `packages/api/src/trueppm_api/apps/scheduling/services.py::enqueue_recalculate()` — write the
  outbox row inside `transaction.atomic()`, attempt `.delay()` in `transaction.on_commit()`,
  swallow broker errors, and rely on a 30-second drain. New async dispatch paths must follow it.

**Greenfield**: there is no email backend, no transactional email helper (`grep` finds zero
`send_mail` / `EmailMessage` references in source), and no `Notification` or
`UserNotificationPreference` model. The email and notification surfaces have no prior shape to
preserve, so we get to choose cleanly.

### What "extension point" must mean here

Django's `models.TextChoices` is a class-level enum and is **not runtime-extensible**. If OSS hard-codes
`provider in {gitlab, github, other}`, Enterprise cannot add `jira` or `bitbucket` without forking the
OSS field definition — which violates the Apache 2.0 boundary rule
("the OSS core must remain fully functional without the enterprise repo … extension points must
remain stable — enterprise code registers against them").

The chosen shape must let Enterprise add provider keys at app-startup time without OSS migrations,
without OSS code changes, and without breaking the OSS `grep -r "trueppm_enterprise" packages/`
boundary check.

## Decision

Adopt a **provider-registry pattern** for all three extension points, structured the same way so
the architectural shape is identical and easy to reason about across teams.

### 1. The registry pattern (one shape, three uses)

For each extension point, the storage is a `CharField(max_length=32)` plus a class-level Python
registry mapping `key → handler class`:

```python
# packages/api/src/trueppm_api/apps/integrations/registry.py
class ProviderRegistry:
    """A registry of provider keys → handler classes.

    Three instances exist: TASK_LINK_PROVIDERS, OUTGOING_CHANNEL_PROVIDERS,
    NOTIFICATION_CHANNELS. OSS apps register their built-ins at AppConfig.ready().
    Enterprise apps register their additions at AppConfig.ready() too — same hook, same
    timing, no monkey-patching.
    """

    def __init__(self, name: str, base_class: type):
        self._name = name
        self._base = base_class
        self._registry: dict[str, type] = {}

    def register(self, key: str, handler: type) -> None:
        if key in self._registry:
            raise ValueError(f"{self._name}: provider {key!r} already registered")
        if not issubclass(handler, self._base):
            raise TypeError(f"{self._name}: {handler} must subclass {self._base}")
        self._registry[key] = handler

    def get(self, key: str) -> type | None:
        return self._registry.get(key)

    def keys(self) -> list[str]:
        return sorted(self._registry)
```

`CharField` storage means:

- No DB migrations when Enterprise adds a provider.
- No `TextChoices` value list to keep in sync between OSS and Enterprise.
- Validation happens against the *current registry* at write time — code-level, not schema-level.
- Old rows for a now-unregistered provider degrade gracefully (the field still reads, the handler
  just returns `None`; UI shows "Unknown provider").

The three registries:

| Registry | Base class | OSS keys | Enterprise keys (examples) |
|---|---|---|---|
| `TASK_LINK_PROVIDERS` | `TaskLinkProvider` | `gitlab`, `github`, `generic` | `jira`, `servicenow`, `bitbucket`, `azure_devops` |
| `OUTGOING_CHANNEL_PROVIDERS` | `OutgoingChannelProvider` | `slack`, `generic` | `slack_app`, `teams`, `discord_rich` |
| `NOTIFICATION_CHANNELS` | `NotificationChannel` | `email`, `in_app` | `slack_dm`, `teams_dm`, `sms` |

Each base class is an ABC with a small, stable interface. For example:

```python
class TaskLinkProvider(abc.ABC):
    key: ClassVar[str]

    @classmethod
    @abc.abstractmethod
    def matches(cls, url: str) -> bool: ...

    @abc.abstractmethod
    def fetch_metadata(self, url: str, credential: Credential) -> LinkMetadata: ...
```

```python
class OutgoingChannelProvider(abc.ABC):
    key: ClassVar[str]

    @abc.abstractmethod
    def render(self, event: TaskEvent) -> dict: ...  # provider-specific JSON shape

    @abc.abstractmethod
    def post(self, url: str, payload: dict, secret: str | None) -> DeliveryResult: ...
```

```python
class NotificationChannel(abc.ABC):
    key: ClassVar[str]

    @abc.abstractmethod
    def send(self, user: User, event: TaskEvent) -> DeliveryResult: ...
```

Enterprise registers richer handlers at `AppConfig.ready()` in the trueppm-enterprise package. The
same hook OSS uses. There is no "if Enterprise installed" branch in OSS code — the registries are
empty until something registers, and OSS registers its own.

### 2. Reuse existing `apps/webhooks/` for OSS outgoing channels — do not create `BoardOutgoingChannel`

Issue #302 originally proposed a new `BoardOutgoingChannel` model. The codebase scan shows
`apps/webhooks/Webhook` already provides project-scoped outbound webhooks with HMAC signing,
retry/backoff, and a delivery audit table. **Extending it is the right move; duplicating it is not.**

Concrete changes to `apps/webhooks/`:

- Add `format` field: `CharField(max_length=32, choices=OUTGOING_CHANNEL_PROVIDERS_at_load_time, default="generic")`.
  At write time, validation checks the field value is in `OUTGOING_CHANNEL_PROVIDERS.keys()`.
- Extend `WebhookEventType` with the four new task events: `task.assigned`, `task.assignee_changed`
  (David's blocker), `task.mentioned`, `task.due_date_changed`. Total OSS event types becomes 11.
  **Hard cap** on additions — adding a 12th requires its own ADR; this is the gate that prevents
  scope creep into per-customer event proliferation, which is the explicit Enterprise upsell.
- `webhooks/dispatch.py` looks up the provider via `OUTGOING_CHANNEL_PROVIDERS.get(webhook.format)`,
  calls `.render(event)` for the payload shape, then existing `deliver_webhook` retries it.
- The OSS `slack` provider renders Slack-attachment JSON; `generic` posts the existing internal
  envelope. Discord and Mattermost incoming-webhook URLs accept the Slack shape, so `slack`
  covers them too.
- Enterprise's `slack_app` provider replaces the URL post with an authenticated Slack Web API call
  using the installed-workspace token; everything else (subscription model, delivery audit, retry)
  stays the same.

This eliminates the originally-proposed `BoardOutgoingChannel`. **The OSS subscription model
remains project-scoped** to match the existing `Webhook`; #302's "per-board" framing should be
updated to "per-project" before implementation.

### 3. New OSS app: `apps/integrations/` (task links + credentials)

Greenfield — there is no existing home for `TaskLink` or per-user PAT storage. New Django app
`integrations`:

- `TaskLink` (subclass of `VersionedModel` — has `server_version`, `is_deleted`, `deleted_version`
  for sync parity with `Task`): `task` FK, `url`, `provider` (CharField, validated against
  `TASK_LINK_PROVIDERS.keys()`), `title`, `status`, `fetched_at`, `display_order`. RBAC follows
  task-edit.
- `IntegrationCredential` (per-user, per-provider): `user` FK, `provider`, `secret_ciphertext`
  (encrypted at rest with key from `settings.INTEGRATION_ENCRYPTION_KEY`, sourced from a Helm
  value), `base_url` (for self-hosted GitLab / GitHub Enterprise), `created_at`. **Never serialized
  back to the client** — the API exposes "credential exists" / "rotate" / "delete," never the
  ciphertext or plaintext.
- Refresh endpoint is **synchronous** (`POST /api/tasks/{id}/links/{link_id}/refresh`): the user
  clicked a button and is staring at the spinner. No outbox, no Celery — just a request-cycle
  HTTP call to the provider with a 5-second timeout, status cached on the row. SSRF protection via
  an allow-list of known git host patterns plus a deny-list for RFC1918 ranges.

### 4. New OSS app: `apps/notifications/` (preferences + delivery)

Also greenfield. New Django app `notifications`:

- `UserNotificationPreference` (per-user, per-event-type, per-channel): `user`, `event_type`
  (free-form string matching a `WebhookEventType` value — one source of truth for event names),
  `channel` (CharField, validated against `NOTIFICATION_CHANNELS.keys()`), `enabled`. Default rows
  are seeded only for the user's **own-task events** (`task.assigned` to me, `task.mentioned` of
  me, `task.updated` for due-date change on a task I own); aggressive defaults would lose Priya
  (VoC blocker).
- `NotificationDelivery` (delivery audit, structurally similar to `WebhookDelivery`): `user`,
  `event_type`, `channel`, `status`, `attempt_count`, `payload`. Reused dispatch shape — drain
  task pattern is identical.
- `services.py::enqueue_notifications(event)` writes `NotificationDelivery` rows inside the
  request transaction, defers `.delay()` via `transaction.on_commit()`, and a new
  `drain_notification_queue` Beat task (every 30 seconds, `@idempotent_task(on_contention="skip")`)
  re-dispatches any `PENDING` row older than 5 minutes.
- Email backend: SMTP via Django's built-in `EmailBackend`, configured through Helm values
  (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`). HTML + plain-text
  templates. Unsubscribe link in every email (regulatory).

### 5. Where the boundary sits

| Concern | OSS | Enterprise |
|---|---|---|
| Provider registries | Defined in `apps/integrations/registry.py`; OSS providers registered in `apps/integrations/apps.py` | Enterprise providers registered in its own `AppConfig.ready()` |
| `TaskLink` model | OSS owns the table | Enterprise reads/writes the same table; never alters the schema |
| `Webhook` model + `format` field | OSS owns the table and the dispatch loop | Enterprise registers richer formats; never alters the schema |
| `UserNotificationPreference` | OSS owns the table and the channel list | Enterprise registers `slack_dm`, `teams_dm`, `sms` channels |
| Webhook *ingest* (PR merged → task closed) | Out | New Enterprise app, separate URL prefix, separate Celery queue |
| Email-in / portfolio digests / Slack App / immutable audit trail | Out | Enterprise |

`grep -r "trueppm_enterprise" packages/` continues to return zero in OSS code.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. `TextChoices` enum, swapped at runtime in Enterprise** | Familiar Django shape, type-checked at write time | Not actually runtime-extensible — Enterprise would need to monkey-patch the choices class. Breaks `grep "trueppm_enterprise"` cleanliness. Migration whenever providers change. |
| **B. Subclass-replacement (Enterprise subclasses `TaskLink` and adds providers)** | Type-safe inheritance | Enterprise inheriting OSS models requires Enterprise migrations and a parallel API surface. Doubles the read paths in serializers. Foundation for divergence. |
| **C. Provider key as `CharField` + class registry** *(chosen)* | One model owned by OSS, no migrations on Enterprise additions, identical shape across all three extension points, AppConfig.ready() is the same hook OSS already uses | Validation is code-level, not schema-level — a bug in registry registration would let an unknown key write. Mitigated by registering at app startup and asserting non-empty in tests. |
| **D. Generic JSONB metadata blob, no typed providers** | Maximum flexibility | Loses the contract that lets Enterprise register a *typed* fetcher; pushes provider knowledge into every read site. The point of the extension point is type-safe handlers, not free-form metadata. |
| **E. New `BoardOutgoingChannel` model duplicating `apps/webhooks/`** | Clean per-feature naming | Duplicates the entire delivery, retry, and audit substrate that already exists. Two divergent code paths to maintain; two sets of bugs. Rejected once codebase scan showed the existing infra. |

## Consequences

### What becomes easier
- Enterprise can add Jira, ServiceNow, Bitbucket, Teams, SMS without an OSS release or an OSS migration.
- The OSS test suite covers the dispatch loop once; Enterprise tests cover the new provider classes
  in isolation. No combinatorial test matrix.
- Self-hosted OSS users get a working SMTP and one-way Slack/Discord/Mattermost integration without
  needing the Enterprise license.
- Issue #302's scope simplifies: no new `BoardOutgoingChannel`, no new dispatch code — just a
  `format` field, four new event types, and the `slack` renderer registered against the existing
  webhooks app.

### What becomes harder
- A bug in registry registration (typo'd key, missing `register()` call) is a runtime failure rather
  than a compile-time / migration-time failure. Mitigation: `apps/integrations/tests/test_registry.py`
  asserts the OSS providers are present at app-ready and rejects unknown keys at write time.
- Validation logic moves from `TextChoices` enforcement to a custom `clean()` / serializer
  validator. Slightly more code per write site.
- The same provider key namespace is shared between OSS and Enterprise — collisions (`slack` in
  OSS vs `slack_app` in Enterprise) must be deliberate, not accidental. Mitigation: the `register()`
  call raises on duplicate keys.

### Risks
- **SSRF on user-supplied URLs** (git URL paste, webhook URL config). `/security-review` mandatory
  before merge. Allow-list of git host patterns; deny-list for RFC1918, link-local, and
  cloud-metadata IPs. Webhook URL host validation reuses the same deny-list.
- **PAT leakage**: encryption-at-rest plus never-returned-to-client. Helm value provides the
  encryption key; KMS-backed key is an Enterprise hardening item, not OSS-blocking.
- **Slack / Discord / Mattermost payload drift**: incoming webhook accepting Slack-shape is a
  de-facto standard but not formally guaranteed. If a target rejects the payload, the existing
  `WebhookDelivery.response_status` audits the failure; no silent loss.
- **Notification fan-out**: a status change on a task with N watchers writes N
  `NotificationDelivery` rows in one transaction. `/perf-check` must verify no N+1 in the
  preference lookup; bulk-fetch preferences once per dispatch.

## Implementation Notes

- **P3M layer**: Programs and Projects (OSS).
- **Affected packages**: `api` (new `apps/integrations/`, new `apps/notifications/`, modified
  `apps/webhooks/`), `web` (link UI, channel config UI, preference UI), `helm` (SMTP env vars,
  `INTEGRATION_ENCRYPTION_KEY`).
- **Migration required**: yes — three new tables (`TaskLink`, `IntegrationCredential`,
  `UserNotificationPreference`, `NotificationDelivery`), one altered (`Webhook` gains `format`),
  one ArrayField choices update (`WebhookEventType` gains four values).
- **API changes**: yes —
  - `GET/POST/DELETE /api/tasks/{id}/links`
  - `POST /api/tasks/{id}/links/{link_id}/refresh` (synchronous, 5s timeout)
  - `GET/POST/DELETE /api/users/me/credentials/{provider}`
  - `GET/POST/PATCH/DELETE /api/projects/{id}/webhooks` *(extend existing — add `format`)*
  - `GET/PUT /api/users/me/notification-preferences`
- **OSS or Enterprise**: this ADR is **OSS** (`docs/adr/0049`). The Enterprise companion (webhook
  ingest, Slack App, email-in, portfolio digests, audit trail) is governed by trueppm-enterprise#57
  and any Enterprise-side ADR it spawns.
- **Issue #302 corrections required before implementation**:
  - Replace "per-board" outgoing channel with "per-project" to align with existing `Webhook`.
  - Remove the claim that retry/backoff is Enterprise-only — OSS inherits it from `apps/webhooks/`.
  - Replace the proposed `BoardOutgoingChannel` model with the `format` field on `Webhook` plus
    the new event types.

### Durable Execution

1. **Broker-down behaviour**: outbox pattern.
   - Outgoing channels: existing `apps/webhooks/dispatch.py` writes `WebhookDelivery` rows in the
     request transaction and attempts `deliver_webhook.delay()` in `transaction.on_commit()`,
     swallowing broker errors. Already implemented.
   - Notifications: new `notifications/services.py::enqueue_notifications()` writes
     `NotificationDelivery` rows in the request transaction and attempts `send_notification.delay()`
     in `transaction.on_commit()`, swallowing broker errors. Same pattern as scheduling and webhooks.
   - Task-link refresh: synchronous request-cycle HTTP, no broker involvement. N/A.
2. **Drain task**:
   - Outgoing channels: reuses the existing 30-second `drain_webhook_queue` Beat task. No new drain.
   - Notifications: new 30-second Beat task `drain_notification_queue` with
     `@idempotent_task(on_contention="skip")`. Semantics differ from webhook drain (different
     model, different dispatch task) so reuse is not appropriate.
3. **Orphan window**: 5 minutes for both webhook and notification drains — matches the existing
   webhook drain threshold. Rows newer than 5 minutes are still potentially inside an open
   `transaction.on_commit()` callback and must not be re-dispatched.
4. **Service layer**:
   - Outgoing channels: existing `webhooks/dispatch.py::dispatch_webhooks()`.
   - Notifications: new `notifications/services.py::enqueue_notifications(event)`. Direct
     `.delay()` from views or signals is forbidden (matches the scheduling app's discipline).
5. **API response on best-effort dispatch**: `202 {"queued": true}` for any endpoint that triggers
   notification or webhook dispatch as a side effect. Synchronous endpoints (link CRUD, link
   refresh, preference update, credential CRUD) return their resource representation directly.
6. **Outbox cleanup**: `WebhookDelivery` retention is already governed by existing webhooks-app
   policy (no change). `NotificationDelivery` retention: SUCCESS rows purged after 30 days;
   FAILED rows retained 90 days for ops debugging. New nightly Beat task
   `purge_notification_deliveries`.
7. **Idempotency**: `WebhookDelivery.id` (UUID) is the natural idempotency key for retries
   (existing). `NotificationDelivery.id` is the same. `deliver_webhook` and `send_notification`
   short-circuit when the row's `status` is no longer `PENDING`.
8. **Dead-letter / failure handling**: existing webhooks app caps at 5 retries with exponential
   backoff and marks `FAILED`; no DLQ topic — the row itself is the record. Notifications adopt
   the same shape: 5 retries, exponential backoff, then `FAILED`. Admin UI surfaces failed-delivery
   counts (Enterprise extends to a richer audit-log viewer).
