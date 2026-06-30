# ADR-0076: Integration Management Surface Boundary (Workspace vs Project vs Program)

## Status
Accepted — extended on 2026-05-21 to add program-scope integrations (see Revisions below). — implemented on main; status corrected 2026-06-30 after ADR audit (verified: IntegrationsRedirect)

## Context

ADR-0049 ("External Integration Extension Points") established the OSS backend
substrate: three Python provider registries (`TASK_LINK_PROVIDERS`,
`OUTGOING_CHANNEL_PROVIDERS`, `NOTIFICATION_CHANNELS`), the open-ended
`NotificationPreference.channel` shape, and the rule that Enterprise registers
providers at `AppConfig.ready()` without OSS migrations.

ADR-0049 did **not** specify *where* the integration management UI lives in the
TruePPM scope hierarchy (Workspace → Program → Project). The current frontend
ships two artifacts that pre-empt that decision incorrectly:

1. `packages/web/src/features/settings/WorkspaceIntegrationsPage.tsx` —
   a workspace-scoped page with twelve hardcoded connector cards (GitLab,
   GitHub, MS Project, Slack, Google Calendar, Google Drive, Outlook, Jira,
   Linear, Zoom, Datadog SIEM, ServiceNow) plus a "Browse marketplace" CTA.
   No backend wiring. Routed at `/settings/integrations` in the OSS bundle.
2. `packages/web/src/features/settings/WorkspaceWebhooksPage.tsx` —
   a workspace-scoped page with API token and webhook UI. No backend wiring.
   Routed at `/settings/webhooks-api` in the OSS bundle. Note that the
   underlying `Webhook` model (ADR-0019) is **project-scoped**, so a
   workspace-scoped management surface is structurally wrong even before
   the OSS/Enterprise boundary is considered.

The Workspace surface as currently drafted is portfolio-governance UI:
multi-program scope picker, "Organization > Groups & teams", "Roles &
permissions" (custom roles), marketplace browse. Per CLAUDE.md and the
`enterprise-check` skill, "integration hub (Jira/GitLab/ServiceNow
connectors)" is explicitly enumerated as an Enterprise feature. Leaving the
workspace surface in the OSS bundle:

- Misleads adopters into expecting a marketplace that does not exist in OSS.
- Forces an MR-by-MR debate on what "Available" cards mean when only OSS
  providers can connect.
- Re-creates the boundary leak ADR-0029 (frontend slot registry) was
  designed to prevent.
- Conflicts with the actual OSS data model: `Webhook` and
  `NotificationPreference` storage live at project + user scope, not
  workspace.

This ADR draws the surface boundary explicitly, before the 0.2 settings
wire-up work (#522, #537, #538, #302) hardens the wrong shape.

P3M layer: Programs and Projects (OSS) for the per-project surface; Senior
Leadership / Portfolios (Enterprise) for the workspace-scoped hub.

## Decision

**The OSS integration management surface lives at `Project → Settings →
Integrations` and `Project → Settings → Notifications`. The workspace-scoped
"Integration Hub" surface lives in Enterprise and is registered via the slot
registry from ADR-0029.**

Concrete consequences:

### 1. OSS surface — project-scoped

Two pages under `Project Settings`:

- `Project → Settings → Integrations` (new tab): lists this project's
  outgoing webhooks (`Webhook` model, ADR-0019), inbound API tokens
  (`ProjectApiToken`, ADR-0068), and connected per-user credentials
  (`IntegrationCredential`, scoped per ADR-0049). Project-Admin RBAC for
  webhook CRUD; per-user RBAC for credentials.
- `Project → Settings → Notifications` (existing static page; wired by
  #522): event × channel toggle matrix backed by
  `NotificationPreference`. Channels available in OSS: `in_app`, `email`.
  Slack outgoing-webhook channel (`slack` format on `Webhook`) is OSS,
  per #302.

No workspace-scoped integration UI ships in OSS. The current
`WorkspaceIntegrationsPage` and `WorkspaceWebhooksPage` files are removed
from the OSS bundle. The routes `/settings/integrations` and
`/settings/webhooks-api` are reserved as Enterprise-only slots and resolve
to a 404 (or the Enterprise upsell card from ADR-0072 if the user has
permission to see upsell affordances).

### 2. Enterprise surface — workspace-scoped via slot registry

Enterprise registers two new `SlotId` values:

- `SlotId.workspace_settings.integrations_hub` — renders the full
  marketplace-style hub UI: 12+ connector cards, search, category filters,
  bidirectional connection state, per-tenant credential management,
  workspace-level audit log. Routes at `/workspace/:id/settings/integrations`.
- `SlotId.workspace_settings.connections_overview` — renders aggregated
  health/sync status for every connection in the workspace
  (cross-program), the equivalent of a portfolio dashboard scoped to
  integrations.

Enterprise also registers the additional Python providers (Jira, Linear,
ServiceNow, Datadog SIEM, MS Project 2-way) against the OSS registries
from ADR-0049, plus the `IntegrationCredential` Enterprise extension
(workspace-scoped OAuth + KMS-backed encryption, per the data-model
recommendation in this ADR's research phase).

### 3. New OSS slot definitions

The `SlotId` enum in `packages/web/src/lib/widget-registry.ts` gains:

- `project_settings.integrations` (priority 600, reserved OSS band)
- `task_detail.external_links` (priority 350 in the task-detail section
  ladder defined by ADR-0050, between Dependencies-200 and Subtasks-300 —
  the natural position for "what is this task linked to externally")

Both slots are registered by OSS by default. Enterprise can re-register
a higher-priority component at the same slot ID to extend the UI (e.g.
rendering a Jira bidirectional-sync status card inside
`project_settings.integrations`).

### 4. Per-connector classification (consolidated)

| Connector | Repo | OSS issue | Enterprise issue |
|---|---|---|---|
| GitLab task URLs + on-demand status | OSS | #302 | — |
| GitHub task URLs + on-demand status | OSS | #302 | — |
| Slack outgoing webhook (`format=slack`) | OSS | #302 | — |
| SMTP email notifications | OSS | #302 | — |
| Google Calendar 1-way export | OSS | #570 (0.3) | — |
| Outlook 365 1-way export | OSS | #570 (0.3) | — |
| Google Drive on-demand preview | OSS | #571 (0.3) | — |
| Zoom milestone meeting link | OSS | #572 (0.3) | — |
| MS Project one-shot import/export | OSS (shipped) | ADR-0021 | — |
| Generic outbound webhook | OSS (shipped backend) | ADR-0019 | — |
| GitLab/GitHub webhook ingest + bidi | Enterprise | — | trueppm-enterprise#57 |
| Slack App (OAuth + slash commands) | Enterprise | — | trueppm-enterprise#57 |
| Jira bidirectional | Enterprise | — | trueppm-enterprise#57 |
| Linear bidirectional | Enterprise | — | trueppm-enterprise#117 |
| ServiceNow risk/incident sync | Enterprise | — | trueppm-enterprise#116 |
| MS Project 2-way baseline sync | Enterprise | — | trueppm-enterprise#118 |
| Datadog SIEM audit-log stream | Enterprise | — | trueppm-enterprise#115 |
| Marketplace + workspace hub UI | Enterprise | — | trueppm-enterprise#114 |

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Keep `WorkspaceIntegrationsPage` in OSS as a "Browse marketplace" upsell card** | No file deletion; visible to adopters at install | The page already renders connectors as `Connected` — actively misleading. Forces every connector card to have an OSS/Enterprise split renderer. Re-establishes the boundary leak we are trying to remove. |
| **B. Make all integration management workspace-scoped in OSS** | Single source of truth for connectors; matches the screenshot | Conflicts with `Webhook` and `ProjectApiToken` being project-scoped models. Would require a database migration to add workspace FK fields. Pushes the OSS adopter into a workspace-management mindset they may not have (a single-PM adopter with one project doesn't need workspace UI). |
| **C. Project-scope OSS + Enterprise workspace hub via slot registry (this ADR)** | Matches existing data scope; clean OSS/Enterprise line; no migration needed; uses the slot registry pattern already in production | Requires deleting two OSS frontend files (with their tests); requires a 404/upsell affordance at the now-empty workspace routes; PMs with multiple projects must navigate per-project to manage connectors |
| **D. Defer the decision; keep workspace pages as 'preview' until 1.0** | No work | Locks in the boundary leak across two minor releases; #537 and #538 are already wiring static pages that will need re-work. The "Preview — not yet saved" banner (#538) is exactly the kind of half-measure that converts to debt. |

Selected: **C**.

## Consequences

**Easier:**
- Boundary is auditable in one line: `WorkspaceIntegrationsPage.tsx` and
  `WorkspaceWebhooksPage.tsx` should not exist in OSS. `grep -r
  'workspace_settings.integrations_hub' packages/` should return zero
  results in OSS code (only Enterprise registers it).
- OSS adopters see a coherent project-scoped story: webhooks/tokens/prefs
  all live in `Project → Settings`. No "Available" cards they can't
  connect.
- Existing 0.2 wire-up issues (#522 for Notifications) are unaffected —
  they are already correctly project-scoped.
- Enterprise teams get a clean slot to register against, without
  monkey-patching OSS routes.

**Harder:**
- A single-PM, multi-project OSS adopter has to set webhook prefs per
  project. There is no "set this Slack URL for all my projects" affordance
  in OSS. (Acceptable: the typical OSS adopter has 1–3 projects; the
  cross-project rollup story is exactly the Enterprise upsell.)
- The 404 / upsell card at `/settings/integrations` needs a graceful empty
  state — see Implementation Notes for the recommended shape.

**Risks:**
- **#537 (in-flight 0.2)** is fixing static placeholders on
  `WorkspaceIntegrationsPage`. If that issue lands before this ADR is
  accepted, the placeholder fix gets thrown away with the page removal.
  Mitigation: this ADR must accept-or-reject before #537 starts. If #537
  ships first, the 0.2 changelog must explicitly mark
  `WorkspaceIntegrationsPage` as deprecated and slated for removal in 0.3.
- **OSS adopters who reach `/settings/integrations` via an external
  bookmark or onboarding link** get a confusing 404. Mitigation: the
  removed route renders a `<IntegrationsRedirect />` component that points
  to the user's first project's integrations tab.

## Implementation Notes

- **P3M layer**: Programs and Projects (OSS surface) + Portfolios
  (Enterprise hub)
- **Affected packages**: `web` primarily; `api` for the new
  `project_settings.integrations` view aggregator endpoint
- **Migration required**: no schema changes. Frontend-only.
- **API changes**: small aggregator endpoint `GET
  /api/v1/projects/:id/integrations-summary/` returning the per-project
  list of webhooks + tokens + connected credentials in one round-trip
  (otherwise the new page does three sequential calls). RBAC: project
  Member to read, project Admin to mutate (delegates to underlying
  viewsets).
- **OSS or Enterprise**:
  - This ADR + the OSS slot definitions + the `Project → Settings →
    Integrations` page → **OSS** (trueppm-suite)
  - The workspace hub UI + bidirectional connectors + marketplace +
    workspace audit log → **Enterprise** (trueppm-enterprise)
- **Removal plan for `WorkspaceIntegrationsPage` / `WorkspaceWebhooksPage`**:
  delete the files; remove the routes from the OSS router; add a redirect
  shim at the old paths that resolves to
  `/projects/:default_project_id/settings/integrations` for the OSS user,
  or to the Enterprise hub for the Enterprise user (slot-registered
  redirect target).
- **Empty state for OSS users with zero projects**: render the project
  picker with an empty-state message. Do not render a static
  marketplace.

### Durable Execution

1. **Broker-down behaviour**: N/A — this is a surface-boundary
   ADR. The underlying outgoing-webhook dispatch already uses the outbox
   pattern via ADR-0019's `dispatch_webhooks()` +
   `transaction.on_commit()`. The new `integrations-summary` aggregator
   endpoint is read-only and synchronous.
2. **Drain task**: N/A — no new async dispatch path. Existing webhook
   delivery drain (ADR-0019) and notification email drain (ADR-0075
   phase 3) cover all dispatch in this scope.
3. **Orphan window**: N/A — same reason.
4. **Service layer**: aggregator endpoint goes through a new
   `integrations/services.py::summarize_project_integrations(project_id)`
   that consults the three existing services (webhooks, projects api
   tokens, integrations credentials) and assembles a DTO. Read-only,
   no side effects.
5. **API response on best-effort dispatch**: N/A.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: GET endpoint, idempotent by definition. Aggregator
   has no write path.
8. **Dead-letter / failure handling**: if any underlying service errors,
   the aggregator returns 503 with which subservice failed
   (`{"failed": "webhooks"}`); the per-section UI then falls back to
   loading that section's data via its own viewset.

## Open Questions

1. Does the OSS `Project → Settings → Integrations` page need a
   "Connect a new integration" affordance, given that OSS connectors
   are limited to webhook URL + git URL paste + email opt-in? Or is the
   page a read-only summary with deep-links to the underlying CRUD
   pages? **Recommendation: read-only summary in 0.2; CRUD inline in
   0.3.**
2. Where do **per-user** credentials (GitLab PAT, GitHub PAT — ADR-0049
   §IntegrationCredential) live in the UI? They are not project-scoped
   data. **Recommendation: a separate `User → Settings → Connected
   Accounts` page in OSS; the project page shows "you have N connected
   accounts that this project can use".**
3. Should the Enterprise workspace hub be reachable from an
   OSS-installed instance with a "Upgrade to manage workspace-wide
   integrations" upsell? **Recommendation: yes, gated on the
   `enterprise-upsell-affordances` flag established in #541.**

These questions do not block ADR acceptance; they are deferred to the
`/ux-design` pass on the OSS page.

## Revisions

### 2026-05-21 — Program-scope integrations

The original ADR scoped OSS integrations to project-level only. Practical
review on the implementation MR (#569 / !313) surfaced a gap: a program
manager running 5 projects pastes the same Slack URL into 5 project
settings pages. That friction is exactly what the OSS `Program` entity
(ADR-0070) was created to eliminate. Workspace-scope integrations remain
Enterprise (per the original decision's adoption test — cross-program
governance is what an *organization* needs, and that's the upsell), but
program-scope is a legitimate OSS need that was incorrectly omitted.

**Extension:**

1. `Webhook.project` becomes nullable; new `Webhook.program` FK added.
   DB-level XOR constraint: exactly one of `project_id` / `program_id`
   is non-null. A program-scoped webhook fires for events on **any
   project within the program**, fanned out by `dispatch_webhooks()`.

2. `ProjectApiToken` renamed to `ApiToken` (backwards-compat alias
   retained as `ProjectApiToken` until 0.4) with the same polymorphic
   scope: nullable `project` and `program` FKs + XOR constraint. A
   program-scoped token authorizes inbound writes into any project the
   program contains; the URL `project_pk` identifies the target project
   on each request and `IsTokenForProject` validates the token's program
   contains that project.

3. New page `Program → Settings → Integrations` mirrors the project
   page, scoped to program-owned resources only (no cross-cutting view
   of child projects' integrations).

4. New endpoint `GET /api/v1/programs/{pk}/integrations-summary/` —
   same shape and per-section 503 fallback as the project endpoint.

5. CRUD UI for program-scoped webhooks and tokens is deferred to 0.3
   (mirrors the project surface, which also defers CRUD-inline). For
   0.2, mutations go through the API directly. A follow-up issue
   covers the CRUD UI parity.

**Why not also workspace-scope in OSS?** A solo PM with 1–3 projects
benefits from program-scope; a single-tenant org with 20 programs needs
workspace-scope, and that's the Enterprise upsell. The adoption test
from the original decision still holds for the workspace boundary.

**Decision-framework footprint:** the original Selected: **C** still
stands. Program-scope is layered on top — it does not change the OSS /
Enterprise boundary, only the OSS-internal scope hierarchy. Enterprise
still re-injects the workspace surface via the slot registry.
