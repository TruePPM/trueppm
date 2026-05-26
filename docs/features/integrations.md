# Integrations

TruePPM's integration management surface in the OSS edition lives at **two
scopes**:

- **Project** — `Project → Settings → Integrations` — for resources that
  belong to one project (per-project Slack channel, per-project CI tokens)
- **Program** — `Program → Settings → Integrations` — for resources that
  span every project in a program (one Slack channel for the whole program,
  one CI token that can push tasks into any project the program owns)

A program-scoped webhook fires for events on **any** project in the program;
a program-scoped API token authorizes inbound writes into **any** project
the program contains. Configure once at the program level instead of
copy-pasting the same URL into every child project.

!!! info "Edition"
    Both OSS surfaces are governed by **ADR-0076**. A workspace-scoped
    **Integration Hub** with a marketplace of bidirectional connectors
    (Jira, Linear, ServiceNow, …), workspace-level audit log, and KMS-backed
    credential storage is part of the Enterprise edition.

## Scope decision tree

| Primitive | Scope | Reason |
|---|---|---|
| Webhook | Project **or** Program (XOR) | Project for single-project routing; Program for one channel across all projects in the program |
| API Token | Project **or** Program (XOR) | Project authorizes writes into that project; Program authorizes writes into any project the program contains |
| Connected Account | User | A PAT belongs to *you*, not a project or program |

Webhook and API Token records carry a XOR DB constraint: exactly one of
`project_id` / `program_id` is non-null. Ambiguous-scope tokens are
impossible to create.

### Which scope should I use?

- **Project scope** when the integration is specific to one project — e.g. a
  `#project-helios-deploys` Slack channel, or a CI pipeline that only ever
  pushes to one project.
- **Program scope** when you'd otherwise paste the same configuration into
  every project — e.g. a `#program-helios` Slack channel that receives
  events from all projects in the Helios program, or a centralized CI
  pipeline that creates tasks in whichever child project the build belongs to.

The decision is per-resource: a program can have program-wide webhooks **and**
each project can have its own project-scoped webhooks. They're independent
and additive — both fire for events on a project that's part of the program.

A workspace-level "manage all integrations across all programs" surface is
the Enterprise upsell — it's where governance, audit trail, and cross-program
coordination live.

### Endpoints and roles

Each scope has a parallel set of REST endpoints. Reads require membership;
mutations require Admin on the scope object.

| Resource | Project scope | Program scope | Read | Mutate |
|---|---|---|---|---|
| Webhooks | `/api/v1/projects/{id}/webhooks/` | `/api/v1/programs/{id}/webhooks/` | Member | Admin |
| API tokens | `/api/v1/projects/{id}/api-tokens/` | `/api/v1/programs/{id}/api-tokens/` | Member | Admin |
| Token audit | `/api/v1/projects/{id}/api-token-audit/` | `/api/v1/programs/{id}/api-token-audit/` | Member | — |

"Member" means project Viewer+ / program Viewer+; "Admin" means project Admin /
program Admin. A program-scoped webhook fires for events on **any** project in
the program, and a program-scoped token authorizes writes into **any** project
the program contains — both in addition to whatever project-scoped resources
the individual projects define.

## The Integrations page

!!! info "Version"
    Full add/edit/delete/test management of webhooks and API tokens from the
    UI shipped in **0.2**. Earlier releases exposed a read-only summary with a
    "Manage via API" placeholder; mutations now happen in the page.

The same page renders at two scopes:

- `Project → Settings → Integrations` (`/projects/<id>/settings/integrations`)
- `Program → Settings → Integrations` (`/programs/<id>/settings/integrations`)

Both pages are built from one pair of components — a **Webhooks** manager and
an **API Tokens** manager — parameterized by scope. The only differences are
the section labels (Program scope reads "Program webhooks" / "Program API
tokens") and the RBAC required to mutate (project Admin vs. program Admin).

```
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│ Outbound webhooks      3   + New │  │ Inbound API tokens     1   + New │
│ ─────────────────────────────────  │  │ ─────────────────────────────────  │
│ ● hooks.slack.com/…   Slack      │  │ • CI Pipeline                    │
│      task.created +3   Test Edit │  │   tppm_a1b…  ·  used 14h ago     │
│ ● ops.example.com/wh  JSON       │  │                          Revoke  │
│      task.updated +1   Test Edit │  │                                   │
└──────────────────────────────────┘  └──────────────────────────────────┘
```

Each webhook row shows an active dot, the endpoint host, a **format** badge
(`Slack` or `JSON`), its subscribed events, and **Test / Edit / Delete**
actions. Each token row shows its name, masked prefix (`tppm_a1b…`), last-used
time, and a **Revoke** action.

### Managing webhooks

**New** / **Edit** opens the webhook editor, where you set:

- **Endpoint URL** — HTTPS only. The form rejects any non-`https://` URL.
- **Format** — `Slack` or `Generic (JSON)` (see [Webhook formats](#webhook-formats)).
  The picker also lists Enterprise-only formats (Discord, PagerDuty, …) as
  disabled options labelled "Enterprise".
- **Events** — pick one or more of the [11 OSS event types](#webhook-event-types).
  At least one event is required.
- **Signing secret** — used to sign each delivery with HMAC-SHA256 (see
  [Signing secret and verification](#signing-secret-and-verification)). On
  edit, leave the field blank to keep the existing secret; it is write-only and
  never returned by the API.

When the format is `Slack`, the editor shows a live **preview** of the message
your endpoint will receive, so you can confirm the rendering before saving.

**Test** sends a synthetic ping event to the endpoint and reports success or
failure inline — the fastest way to confirm a URL and secret are wired up
correctly before you depend on real events. **Delete** removes the
subscription after a confirmation prompt; deliveries stop immediately.

### Managing API tokens

**New** mints an inbound API token scoped to the project or program. The raw
token is shown **exactly once** in a one-time reveal — copy it immediately,
because it is never retrievable again. The list thereafter shows only the
token name, masked prefix, and last-used time.

**Revoke** disables a token after a confirmation prompt. Revocation is a
soft-delete: the token can no longer authenticate, but its audit history is
retained for compliance. Token mint and revoke both append to the
[API-token audit log](#api-token-audit-log).

## Webhook formats

Each webhook renders its payload in one of two OSS formats, chosen per
subscription. The format is validated at write time against the registered
outgoing-channel providers, so the API rejects an unknown value with the list
of currently selectable formats.

| Format | What is sent | Use it for |
|---|---|---|
| `generic` | The flat TruePPM event payload — for task events, the changed task's fields at the top level (`id`, `project`, `name`, `status`, …, `source`) — plus a reserved `_meta` object carrying `_meta.sequence`. Apart from the additive `_meta` namespace, this is the historical shape; existing webhooks default to `generic`. | Custom tooling, CI pipelines, any consumer that parses JSON itself. |
| `slack` | A Slack incoming-webhook message: a `text` line plus a single attachment with the task fields and a color bar keyed to the event. | Slack — and, because Discord and Mattermost incoming webhooks accept the same shape, those two as well. |

Point a `slack`-format webhook at a Slack/Discord/Mattermost **incoming-webhook
URL** and messages appear in the channel with no consumer-side parsing. The
attachment surfaces only the fields present on the event (status, assignee,
planned start), so a `task.deleted` event does not render empty rows.

!!! info "Edition"
    Richer formats — a Slack App with OAuth and slash commands, Microsoft
    Teams, PagerDuty — are part of the Enterprise edition. They register
    against the same `OUTGOING_CHANNEL_PROVIDERS` extension point (ADR-0049),
    so adding one requires no OSS change. The format picker shows them as
    disabled "Enterprise" options.

## Webhook event types

OSS fires **11 event types** — a deliberate hard cap. Adding a twelfth requires
its own ADR; per-customer event proliferation is an Enterprise concern, not an
OSS one.

| Event | When it fires |
|---|---|
| `task.created` | A task is created — including when a program backlog item is pulled into a project (payload `source: "backlog_pull"`). |
| `task.updated` | A task field changes. |
| `task.deleted` | A task is deleted. |
| `task.assigned` ✨ | A task's assignee transitions from nobody to a user. |
| `task.assignee_changed` ✨ | A task is reassigned from one user to another. |
| `task.mentioned` ✨ | A new comment mentions a user. |
| `task.due_date_changed` ✨ | A task's planned date changes (see note below). |
| `dependency.created` | A task link (FS/SS/FF/SF) is created. |
| `dependency.deleted` | A task link is deleted. |
| `schedule.recalculated` | The CPM scheduler completes a recalculation. |
| `project.created` | A new project is created. |

✨ = added in **0.2**.

A single change can fire more than one event: a PATCH that both reassigns a
task and moves its date fires `task.updated` **plus** the specific
`task.assignee_changed` and `task.due_date_changed` events. Subscribe to
whichever you care about. The specific events are guarded by a before/after
comparison, so a no-op PATCH that does not actually change the assignee or date
does not fire them.

!!! warning "`task.due_date_changed` currently tracks `planned_start`"
    `Task` has no dedicated deadline field today, so `task.due_date_changed`
    fires when a task's **planned start** changes — the PM-committed date. A
    future release ([#690](https://gitlab.com/trueppm/trueppm-suite/-/issues/690))
    adds a `planned_finish` deadline field and re-binds this event to it. The
    event name and payload shape are stable; only the trigger will change.

## Signing secret and verification

Every delivery is signed so your endpoint can confirm it came from TruePPM and
was not tampered with. The signature is in the `X-TruePPM-Signature` header:

```
X-TruePPM-Signature: sha256=<hmac>
```

The HMAC is `HMAC-SHA256(secret, raw_body)`, where `secret` is the signing
secret you set on the webhook and `raw_body` is the exact request bytes.

```python
import hashlib, hmac

def verify(secret: str, body: bytes, signature: str) -> bool:
    expected = "sha256=" + hmac.new(
        secret.encode(), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)  # constant-time
```

Always compare in constant time to avoid timing attacks. The secret is
write-only: it is never returned by any API response, even to the webhook's
owner. To rotate it, edit the webhook and enter a new value; leaving the field
blank keeps the current secret.

Other delivery metadata travels in headers: `X-TruePPM-Event` (the event type),
`X-TruePPM-Delivery` (the delivery UUID — use it as an idempotency key), and
`X-TruePPM-Webhook-Sequence` (a monotonic per-subscription counter for gap
detection). The sequence is also mirrored into the body as `_meta.sequence` —
identical to the header — so in-body gap detection needs no header parsing.
Deliveries are
at-least-once; failed deliveries retry with exponential backoff up to 5
attempts before the delivery row is marked `FAILED`. The
[delivery log](#delivery-log) surfaces the outcome of every attempt.

## Delivery log

The webhook editor's delivery log lists recent deliveries for a subscription —
their event type, status, HTTP response code, attempt count, and timestamps —
so you can confirm events are arriving and debug a failing endpoint. The same
data is available from the API:

```http
GET /api/v1/projects/{id}/webhooks/{webhook_id}/deliveries/
GET /api/v1/programs/{id}/webhooks/{webhook_id}/deliveries/
```

Terminal delivery rows (`SUCCESS`/`FAILED`) are purged on a retention schedule;
see [Outbox and record retention](../administration/retention.md).

## API-token audit log

Minting and revoking an API token both append an immutable entry to the audit
log, scoped to the project or program. The audit trail is **not** purged with
ordinary records — it is retained as compliance evidence.

```http
GET /api/v1/projects/{id}/api-token-audit/
GET /api/v1/programs/{id}/api-token-audit/
```

Any project/program member may read the audit log; only an Admin may mint or
revoke tokens.

## Connected accounts

Per-user personal access tokens (PATs) for GitLab, GitHub, and generic Git
hosts are managed at `User → Settings → Connected Accounts`
(`/me/settings/connected-accounts`). Credentials are per-user, not per-project
or per-program — a PAT belongs to *you* and authorizes status fetches that
preview links into issues, merge requests, and pull requests on tasks.

### What the page does

- Lists one section per provider registered against ADR-0049's
  `TASK_LINK_PROVIDERS` registry — in 0.2 that's **GitLab**, **GitHub**, and a
  catch-all **generic** provider.
- For each provider, surfaces the connection state (Connected / Not
  connected), the optional self-hosted host URL, the credential's
  expiration if you recorded one, and the last time the credential was
  used by the task-link refresh endpoint.
- Provides per-provider **Connect**, **Rotate**, and **Revoke** actions.
  Connect and Rotate share the same upsert API — one row per
  `(user, provider)` pair, never duplicated.
- **Connect and Rotate verify the token before storing it.** GitLab and
  GitHub credentials are checked against the provider's `/user` endpoint;
  a wrong, expired, wrong-scope, or wrong-host token (for example a
  github.com PAT pasted into the GitLab section) is rejected with a clear
  error and **nothing is stored**. The generic provider is accepted without
  a live check, since there is no known endpoint to verify it against.
- Renders a deep-link anchor per provider —
  `/me/settings/connected-accounts#github` scrolls straight to the GitHub
  section. The Project → Settings → Integrations page links here.

### Security guarantees

- Secrets are encrypted at rest with `INTEGRATION_ENCRYPTION_KEY` (set in
  the Helm values, generated with
  `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`).
- The encrypted ciphertext is **never** returned by any API endpoint, not
  even to the credential's owner. The list response exposes only metadata:
  `exists`, `base_url`, `created_at`, `updated_at`, `last_used_at`,
  `expires_at`, and `requires_credential`.
- Cross-user access is impossible by construction — the viewset's queryset
  is scoped to `request.user`, so neither the URL path nor the request
  body can address another user's row.
- Token verification and the task-link refresh both make outbound HTTP calls
  through a single SSRF-guarded egress helper. It resolves the target host
  and refuses any URL that resolves to a private, loopback, link-local, or
  cloud-metadata address, so a self-hosted host URL cannot be used to probe
  internal services. Calls are time-bounded and do not follow redirects.

### What ships in successor issues

- **#637** — Git-aware tasks: the `TaskLink` model and the refresh
  endpoint that consumes these credentials.
- **#639** — Email notifications app: `UserNotificationPreference` with
  defaults seeded for own-task events. Registers OSS channels against the
  `NOTIFICATION_CHANNELS` registry reserved by ADR-0049.

The outgoing webhook `format` extension (Slack renderer + four new task event
types, #638) and the project/program webhook & API-token CRUD UI (#600) shipped
in **0.2** and are documented in [Webhook formats](#webhook-formats),
[Webhook event types](#webhook-event-types), and
[The Integrations page](#the-integrations-page) above.

Enterprise registers richer providers (Jira, ServiceNow, Bitbucket,
Azure DevOps, Slack App, SMS, …) against the same registries from its own
`AppConfig.ready()` — no OSS code changes required.

## What lives in Enterprise

Per the [enterprise-check] decision framework, anything that requires
multi-tenant credential storage, OAuth-driven bots, HMAC webhook ingest, or
cross-program coordination is Enterprise. That includes:

- The workspace **Integration Hub** with marketplace browse and 12+ connectors
- Bidirectional Jira / Linear / ServiceNow sync
- Slack App with OAuth + slash commands
- MS Project 2-way baseline sync
- Datadog / Splunk SIEM audit-log streaming
- Native Google Drive / Box / OneDrive OAuth with permission-aware previews

The OSS extension points (the `OUTGOING_CHANNEL_PROVIDERS`,
`TASK_LINK_PROVIDERS`, and `NOTIFICATION_CHANNELS` registries from ADR-0049)
are the contracts Enterprise registers against. OSS code never imports from
the Enterprise package; the dependency is one-way.

## Workspace-level URLs

The legacy workspace routes (`/settings/integrations`, `/settings/webhooks`)
are still reachable in the OSS bundle, but they no longer render a marketplace
UI. Instead they render a redirect shim:

- If you have **one project**, the page transparently redirects you to that
  project's Integrations tab.
- If you have **two or more projects**, the page renders a project picker so
  you can pick which project's integrations to manage.
- If you have **no projects yet**, the page shows an empty state pointing to
  project creation.

This keeps old bookmarks working while the OSS-canonical path moves to the
project scope.

## Related ADRs

- **ADR-0019** — Outbound Webhooks (the OSS substrate)
- **ADR-0049** — External Integration Extension Points (the OSS registries)
- **ADR-0050** — Task Detail Drawer Section Extension Points (where `task_detail.external_links` registers)
- **ADR-0068** — Inbound Task Sync Protocol (the OSS API tokens)
- **ADR-0076** — Integration Management Surface Boundary (this page's framing)
- **ADR-0084** — Webhook Format Extension, New Task Events, and Project/Program CRUD Surface

[enterprise-check]: ../adr/0076-integration-management-surface-boundary.md
