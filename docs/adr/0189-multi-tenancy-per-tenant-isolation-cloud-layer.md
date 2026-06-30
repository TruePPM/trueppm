# ADR-0189: Multi-Tenancy via Per-Tenant Isolation in the Cloud Layer; OSS Stays Single-Tenant

## Status
Proposed — 2026-06-30. Formalizes a direction decided with the product owner (the
"Chef model" boundary ruling) and an `enterprise-check` classification. The three
follow-up forks have been **resolved** (see *Resolved Decisions* below): ADFS/SAML is
in the hosted MVP, the control plane lives in a new `trueppm-cloud` repo, and
schema-per-tenant is the day-one isolation default. Awaiting formal acceptance and
implementation sign-off.

> **ADR number note:** 0185–0188 are earmarked by in-flight 0.4 worktrees
> (time-tracking, MCP, basic SSO, contractor/agent modeling) that are not yet
> committed; this ADR takes 0189 to avoid collision. If any of those land with a
> different number, reconcile before merge.

## Context

We want to ship a **hosted (SaaS) TruePPM** sooner rather than later. The platform
is today a deliberately **single-tenant, self-hosted** application: `Workspace` is a
singleton config row (`singleton_key=1`, ADR-0087), all data implicitly belongs to
that one workspace, identity is Django's built-in global `User` table, the database
is a single connection string with `ATOMIC_REQUESTS=True`, and there is no
tenant-scoping middleware, router, or `search_path` handling anywhere.

CLAUDE.md and prior ADRs are explicit that **multi-tenancy is an Enterprise
feature** (ADR-0087: "the workspace **is** the installation — a singleton config row,
not a multi-tenant parent. Multi-tenancy remains Enterprise."; ADR-0149: workspace
is "a single-tenant, self-hosted singleton… not multi-tenant white-labeling").

Two forces must be reconciled:

1. **Adoption (the OSS mandate).** The community edition must be "enough for a small
   team to be successful" — a PM and their team fully functional with no Enterprise
   dependency. The OSS core must never import enterprise and must remain fully
   functional standalone (`grep -r "trueppm_enterprise" packages/` returns zero — it
   does today, and must continue to).

2. **Industrialization (the commercial mandate).** A central-IT function buying
   TruePPM to stand up and govern **a tenant per organization or business unit** at
   scale is a different job entirely: provisioning, subdomain routing, billing,
   lifecycle, and identity governance. That industrialization is *why* central IT
   pays. Giving it away in OSS removes the upsell and contradicts the boundary.

**The governing principle (the "Chef model").** Chef shipped multi-tenancy only to
paying customers, but an OSS user who wanted multiple tenants could run multiple
separate Chef servers — it just took more effort. That friction was deliberate: the
headache is the upsell. TruePPM adopts the same posture. **An OSS user who wants more
than one tenant runs more than one install.** The hosted/Enterprise product's entire
value proposition is making that not hurt.

A secondary force is **SSO, specifically ADFS.** The GitLab "global account spanning
many groups" model makes per-tenant SSO painful (home-realm ambiguity,
account-linking conflicts, JIT collisions), and ADFS (SAML-only, IdP-initiated,
quirky NameID/claims) is the worst case. TruePPM has no public-identity social graph
to justify global accounts, so it should not inherit that cost.

**P3M layer.** This is cross-cutting hosting/operations infrastructure, not a P3M
feature. The OSS-facing surface stays at the Programs-and-Projects layer unchanged;
the tenancy capability is an Enterprise/cloud concern sitting *beside* the install,
not inside it.

## Decision

**Multi-tenancy is realized as per-tenant isolation orchestrated by a proprietary
cloud control plane. The OSS install stays single-tenant and is not modified to be
tenant-aware.**

### 1. OSS stays exactly as it is — tenant-naive
- No `workspace_id` tenant column on any OSS model. No tenant middleware. No
  Row-Level Security in OSS. The `Workspace` singleton (`singleton_key=1`,
  `Workspace.load()`) is unchanged.
- `Workspace.subdomain` stays **reserved and read-only to the API** (ADR-0087),
  populated only by the cloud control plane, never by OSS code.
- The OSS escape hatch for "more than one tenant" is **run more than one install**
  (separate database/deployment each) — free, supported, "a bit more of a headache."

### 2. Hosted isolation = a schema or database per tenant, each an *unmodified* OSS install
- **Primary model (day-one default): schema-per-tenant.** One PostgreSQL cluster, one
  Postgres schema per tenant. Each schema is a complete, unmodified OSS install (one
  `Workspace` singleton, its own users, its own projects). High density, low cost —
  fits "many small teams." This is the confirmed default at launch.
- **Premium tier: database-per-tenant.** A dedicated database for tenants needing the
  strongest isolation (regulated, large). This is also the literal, orchestrated form
  of the OSS "run another install" escape hatch. Promotion from shared-cluster schema
  to dedicated DB is a routing change, not an application change.
- Tenant → connection/schema resolution is an indirection owned entirely by the cloud
  layer; OSS code is unaware it exists.

### 3. The cloud control plane is a new proprietary `trueppm-cloud` repo, registered against existing OSS seams
The control plane lives in a **new `trueppm-cloud` repository** (proprietary),
separate from `trueppm-enterprise` so that hosting/billing/routing concerns never
ship into the on-prem Enterprise product — on-prem Enterprise stays governance-only,
and OSS stays unchanged. The control plane owns: tenant provisioning, subdomain
routing (wildcard TLS for `*.trueppm.com`), the **per-tenant migration runner**,
billing, plan limits, and tenant lifecycle. It resolves `subdomain → tenant` *above*
the OSS install and sets
the tenant's `search_path` (schema-per-tenant) or selects the connection
(database-per-tenant) before the request reaches OSS code.

It mirrors the seam patterns already in the codebase:
- `TRUEPPM_EDITION` env gate (ADR-0029) and the `GET /api/v1/edition/` endpoint.
- Function-pointer registration exactly like `register_portfolio_access_provider`
  / `_portfolio_access_provider` (ADR-0030) — a **tenant-resolver provider** that, when
  unregistered (OSS), resolves to the singleton, and when registered (cloud), resolves
  by subdomain.
- `ProviderRegistry` (ADR-0049) for any pluggable per-tenant behavior.

### 4. The per-tenant migration tax lives in the paid layer
Replaying OSS migrations per schema/DB — including the non-regenerable operations
(`CREATE EXTENSION ltree`, `CREATE EXTENSION pg_trgm`, the GiST index on
`projects_task.wbs_path` via `RunSQL`, the `CREATE INDEX CONCURRENTLY` on
`projects_historicaltask`, and the `replaces=` squash path for fresh tenants) — is the
job of the cloud control plane's **migration runner**, not of OSS. The runner must be
idempotent, resumable, and observable, and must respect two known hazards:
- `ltree`/`pg_trgm` are **superuser-only, per-database** DDL — install once per
  database before schema-mode Django migrations run.
- Migration `0090` (`CREATE INDEX CONCURRENTLY`, `atomic = False`) must **not** be
  wrapped in a transaction by the runner.

### 5. Identity & SSO fall out for free
Because each tenant is physically isolated, there is **no shared `User` table** —
identity is tenant-scoped by construction, eliminating the GitLab/ADFS global-account
pain. The flow:
- The cloud layer resolves the tenant by subdomain **before** any credential is
  presented (no home-realm discovery).
- Each tenant install runs its **own single-IdP OIDC config** — this is the existing
  OSS basic-SSO carve-out, unchanged, applied per install.
- The **per-tenant IdP registry**, subdomain→IdP routing, **SAML SP (mandatory for
  ADFS — in the hosted MVP, not a fast-follow)**, SCIM, and enforced org-wide SSO are
  **Enterprise/cloud** (in `trueppm-cloud`) — the org-identity-governance line already
  drawn in CLAUDE.md and ADR-0087's `sso`/`two_fa` placeholder stubs. The hosted MVP
  ships OIDC **and** the SAML SP together because early target customers are AD/ADFS
  shops. Per-tenant SP identity: `entityID =
  https://<tenant>.trueppm.com/saml/metadata`, ACS at the subdomain; NameID →
  tenant-local user; JIT provisioning scoped to the tenant. Reuse the Fernet
  `INTEGRATION_ENCRYPTION_KEY` pattern (ADR-0049/0097) for stored IdP secrets.

### 6. Async surfaces must carry tenant context (cloud layer)
The cloud layer must establish the tenant's schema/connection on every execution
surface: web request (middleware), WebSocket consumer (Channels), and Celery task
(a tenant-aware base task / `before_start` hook, including the `@idempotent_task`
wrapper). WebSocket group names are already `project_{uuid}` (globally unique), so they
are tenant-collision-safe; the consumer must still verify the connecting user's tenant
matches the project's tenant before joining a group. The existing outbox/drain tasks
(schedule, webhook, import, sprint-close, notification, invite, export, workflow) scan
their tables without a tenant discriminator — under schema-per-tenant the runner must
either iterate tenants setting `search_path` per iteration, or run per-tenant Beat
schedules. This is cloud-layer work; OSS drains are unchanged.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Per-tenant isolation, OSS untouched (chosen)** | OSS stays pristine & boundary-clean; identity tenant-scoped by construction (ADFS easy); migration/ops complexity lands in the paid layer; DB-per-tenant doubles as the OSS escape hatch | Lower tenant density than pooled; per-tenant migration runner is real engineering; schema `search_path` must reach Channels/Celery |
| **B. Pooled row-level (`workspace_id` column + RLS in OSS)** | Highest tenant density; cheapest infra; one migration run | **Requires the tenant column in OSS models → industrializes OSS, violating the governing principle.** Puts multi-tenancy plumbing in the community edition that we explicitly want to reserve as the paid upsell. A forgotten filter risks cross-tenant leaks. **Rejected.** |
| **C. GitLab-style global accounts + tenant-per-group** | Users span tenants; familiar | Global identity is the root cause of the ADFS/SSO pain (home-realm ambiguity, account linking, JIT collisions); serves a public-identity social graph TruePPM does not have. **Rejected.** |
| **D. Schema-per-tenant plumbing inside OSS** | Isolation without a tenant column | Still puts tenancy/`search_path` machinery in OSS (industrialization); fights the migration discipline inside the community edition. **Rejected** in favor of keeping the orchestration entirely in the cloud layer. |

## Consequences

**Easier**
- The OSS/Enterprise boundary stays bright and verifiable: OSS gets ~no tenancy code,
  `grep -r "trueppm_enterprise" packages/` stays at zero, community edition remains
  fully functional standalone.
- ADFS/SAML and per-tenant IdP become tractable because identity is physically
  partitioned — no global-account reconciliation.
- A clean commercial story: the "headache" of running N installs is exactly what the
  hosted product removes, so the upsell is intrinsic.
- DB-per-tenant isolation upsell needs no code change — just routing.

**Harder**
- The **per-tenant migration runner** is now a first-class, critical-path system
  (idempotent, resumable, observable; handles extensions, `CONCURRENTLY`, and the
  squash path). This is the heart of the industrialization and the main build cost.
- Tenant context must be threaded through three async surfaces (web/Channels/Celery);
  missing one risks reading the wrong schema.
- Lower density than pooled — many *databases* (premium tier) stress connection
  pooling (size PgBouncer accordingly).

**Risks**
- A half-migrated tenant during provisioning/upgrade is a bad state — the runner must
  be transactional per step and resumable.
- Boundary creep: the temptation to "just add a tenant column to OSS to make hosting
  easier" is precisely the line this ADR forbids. Hold it.
- ADFS onboarding configuration pain remains (NameID formats, IdP-initiated flow,
  cert rollover, no SCIM in older ADFS) even though the architectural pain is removed.

## Implementation Notes
- **P3M layer:** Operations/hosting infrastructure (cross-cutting); the OSS-facing P3M
  surface (Programs and Projects) is unchanged.
- **Affected packages:** *OSS* — none required (optionally a no-op tenant-resolver seam
  mirroring `_portfolio_access_provider`, defaulting to the singleton, if we want the
  hook to live in OSS rather than purely above it). *New* — a proprietary
  **`trueppm-cloud`** repo (the control plane). `packages/helm` — wildcard TLS /
  routing values for the hosted topology.
- **Migration required:** No OSS migration. The cloud layer *runs* existing OSS
  migrations per tenant.
- **API changes:** No OSS API change. New control-plane (cloud) APIs for provisioning,
  routing, billing, and the per-tenant IdP registry.
- **OSS or Enterprise:** OSS core = unchanged single-tenant. Multi-tenancy capability,
  control plane, per-tenant IdP registry, SAML/SCIM = **Enterprise/cloud** (proprietary).

### Cross-reference / addendum to ADR-0087
This ADR **affirms** ADR-0087: `Workspace` remains a singleton in OSS and
`Workspace.subdomain` remains reserved and read-only to the OSS API. The hosted
edition populates `subdomain` from the cloud control plane; OSS never writes it. No
change to the OSS `Workspace` model is implied or permitted by this ADR.

### Durable Execution
*The OSS repo gains no async work from this ADR; the answers below describe the cloud
control plane's provisioning/migration jobs, which is where the durable execution
lives.*
1. **Broker-down behaviour:** Tenant provisioning and per-tenant migration are
   control-plane jobs, dispatched via a transactional outbox in the cloud layer
   (write a `TenantProvisioningRequest` row atomically, attempt dispatch, rely on a
   drain) — mirroring the OSS `ScheduleRequest` outbox+drain pattern (ADR pattern in
   `scheduling/`). No OSS broker path changes. *OSS-side: N/A — no new OSS async work.*
2. **Drain task:** New, in the cloud layer — a provisioning/migration drain (every
   30 s, `on_contention="skip"`). It does not reuse an OSS drain because the work
   (schema create + migration replay) is control-plane-specific.
3. **Orphan window:** Provisioning outbox drain filters rows older than ~5 min to
   avoid racing in-flight commits, consistent with the existing webhook-drain
   convention.
4. **Service layer:** New cloud-layer service, e.g.
   `cloud/provisioning/services.py::enqueue_tenant_provision()` and
   `enqueue_tenant_migrate()`. OSS service layer is untouched.
5. **API response on best-effort dispatch:** Control-plane provisioning returns
   `202 {"queued": true}` — provisioning is asynchronous (schema create + migration
   replay are not synchronous). The tenant becomes routable only after the job
   reports success.
6. **Outbox cleanup:** Completed provisioning/migration outbox rows purged on the
   nightly 7-day-retention schedule (existing convention) in the cloud layer.
7. **Idempotency:** Provisioning keyed on tenant id + target schema/DB name; the
   migration runner is idempotent by Django's `django_migrations` ledger per schema
   (already-applied migrations are skipped) plus a `select_for_update` guard on the
   tenant row to serialize concurrent runs. Re-running a partially-migrated tenant
   resumes from the ledger rather than restarting.
8. **Dead-letter / failure handling:** A provisioning/migration job that exhausts
   retries marks the tenant row `provisioning_failed` (human-actionable in the
   control-plane admin), emits an alert, and leaves the tenant non-routable. No
   partial tenant is exposed to users. An operator can re-trigger from the failed
   state once the cause is fixed.

## Resolved Decisions (2026-06-30)
1. **ADFS/SAML is in the hosted MVP — not a fast-follow.** Early target customers are
   AD/ADFS shops, so the SAML SP and per-tenant IdP registry ship in v1 alongside
   OIDC. This expands MVP scope (a SAML SP, IdP-initiated flow, NameID/claim mapping,
   per-tenant SP metadata) and should be validated with a design-partner AD shop.
2. **The cloud control plane lives in a new `trueppm-cloud` repository** (proprietary),
   separate from `trueppm-enterprise`, so hosting/billing/routing never bleed into the
   on-prem Enterprise product. `trueppm-enterprise` stays on-prem governance only;
   `trueppm-suite` (OSS) is unchanged.
3. **Schema-per-tenant is the day-one isolation default.** Database-per-tenant is the
   premium isolation upsell (regulated/large customers) and the orchestrated form of
   the OSS "run another install" escape hatch; promotion is a routing change.

## Follow-up Work (not blocking this ADR)
- A dedicated **auth/SSO ADR** (or coordination with the in-flight basic-SSO ADR
  earmarked at 0187) detailing the OSS per-install single-IdP OIDC config vs. the
  `trueppm-cloud` per-tenant IdP registry + SAML SP + SCIM, so the OSS/Enterprise auth
  seam is recorded in one place.
- A `trueppm-cloud` design doc for the per-tenant migration runner (the critical-path
  system) covering the extension/`CONCURRENTLY`/squash hazards listed above.

## References
- ADR-0029 — Frontend slot registry & edition detection (`TRUEPPM_EDITION`, `GET /api/v1/edition/`)
- ADR-0030 — P3M shell split / `register_portfolio_access_provider` function-pointer seam
- ADR-0049 — `ProviderRegistry` extension points; Fernet `INTEGRATION_ENCRYPTION_KEY`
- ADR-0061 — "all accounts are org-internal" (single-tenant premise)
- ADR-0087 — Workspace singleton + reserved/read-only `subdomain` (affirmed here)
- ADR-0097 — User-scoped external sync; Fernet credential encryption; SSRF allow-listing
- ADR-0149 — Workspace is single-tenant, not multi-tenant white-label
- Source recommendation: `~/Downloads/trueppm-multitenancy-recommendation-20260630.html`
