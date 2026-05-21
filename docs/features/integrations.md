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

## The Integrations page

`/projects/<id>/settings/integrations` renders a **read-only summary**:

```
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│ Outbound webhooks           3 ●  │  │ Inbound API tokens          1 ●  │
│ ─────────────────────────────────  │  │ ─────────────────────────────────  │
│ ✓ slack.com/hooks/…        3m    │  │ • CI Pipeline                    │
│ ✓ discord.com/api/…       17m    │  │   tppm_a1b…  ·  used 14h ago     │
│ ⚠ ops.example.com/wh       2d ✕  │  │                                   │
│                                   │  │ Manage via API                    │
│ Manage via API                    │  │ (UI coming in 0.3)                │
│ (UI coming in 0.3)                │  │                                   │
└──────────────────────────────────┘  └──────────────────────────────────┘
```

The summary aggregates two backend resources in a single round-trip via
`GET /api/v1/projects/<id>/integrations-summary/`. If one subservice errors,
the page renders the other and shows a Retry button on the failed card —
no waterfall, no page-level blocking error.

In **0.3**, the underlying CRUD pages (Project → Webhooks, Project → API
Tokens) ship and the "Manage via API" inert text becomes an active link.
For now, mutations go through the REST API directly.

## Connected accounts

Connected accounts (per-user PATs for GitLab, GitHub, generic Git hosts) are
managed at `User → Settings → Connected Accounts`. That page ships with the
OSS extension-point work in #302; until it lands, the project Integrations
page surfaces a teaser explaining where credentials will live.

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

[enterprise-check]: ../adr/0076-integration-management-surface-boundary.md
