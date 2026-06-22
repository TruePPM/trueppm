---
title: For Executives
description: How TruePPM gives executive sponsors confidence-weighted forecasts they can trust — without learning the tool or waiting on a hand-built status report.
---

You want one answer, fast: is the work on track, and can you say so out loud without it coming back to bite you? You don't operate the tool day to day — you need numbers you can trust and a forecast honest enough to admit its own uncertainty. This guide covers what TruePPM gives you today, stated plainly, and what's still on the way.

:::note[Run a PMO instead?]
If you manage the program office rather than sponsor from the C-suite — you live in rollups, roles, and the audit log — the [PMO directors guide](/guides/pmo-directors/) is written for you.
:::

## What's available now

### Confidence-weighted scheduling

Unlike traditional tools that show a single "planned finish date," TruePPM's Monte Carlo simulation produces probability distributions:

| Metric | Meaning |
|--------|---------|
| **P50** | 50% chance of hitting this date — where most tools stop |
| **P80** | 80% chance — **the date your team should commit to** |
| **P95** | 95% chance — contractual buffer |

This is available today, per project, via the scheduling engine and API. Your project managers can run Monte Carlo on any project with three-point estimates.

### Data you can trust

The number you repeat to the board is only as good as the data under it. TruePPM enforces a five-role permission model on every project, so people see and change only what their role allows — and it's enforced in the engine, not just hidden in the screen. You can be added as a read-only **Viewer** on any project to watch the live picture without being able to change it. (The [PMO directors guide](/guides/pmo-directors/) and the [RBAC reference](/administration/rbac/) have the full role model.)

### Self-hosted, compliant by design

TruePPM runs on your infrastructure. No data leaves your network. The community edition supports:

- PostgreSQL for data storage (standard backup/recovery)
- Valkey (Redis-compatible) for real-time messaging (stateless, no persistent data)
- JWT authentication with configurable token lifetimes
- Helm chart for Kubernetes deployment

### API-driven reporting

The REST API provides full access to all project data — tasks, schedules, CPM fields, members, resources. If your BI team needs to pull schedule data into a dashboard, the OpenAPI schema documents every endpoint.

## What's coming

The features most relevant to an executive sponsor are split across the community and enterprise roadmaps:

| Feature | Description | Edition |
|---------|-------------|---------|
| Portfolio dashboard | Health scores, RAG status across all projects | Enterprise |
| Demand intake | Prioritization workspace for project proposals | Enterprise |
| Cross-program coordination | Dependencies and alignment across multiple programs | Enterprise |
| Schedule forensics | Narrative detection of what changed and why | Enterprise |
| SSO/SAML/OIDC | Enterprise single sign-on | Enterprise |
| LDAP sync | Automatic user provisioning | Enterprise |
| Immutable audit trail | Compliance-ready change history | Enterprise |
| Board-ready exports | Client-ready Gantt PDF (planned 0.4) and the reporting suite (planned 0.8) | Community (planned) |
| Email/Slack notifications | Event notifications by email and Slack webhook shipped in 0.2; a single-program health digest is planned for 0.8 | Community |
| Portfolio digests | Proactive risk alerts and status summaries across the portfolio | Enterprise |

:::note[Why enterprise?]
These features require coordinating across multiple programs and enforcing governance at the portfolio level — which is the defining characteristic of the enterprise edition. The community edition handles everything a PM or program manager needs (including multi-project programs); the enterprise edition handles the portfolio and org-level governance layer on top.
:::

## Evaluate it yourself (~5 minutes, no login of your own)

You don't need to learn the tool to judge it. Have whoever set up the demo seed it (`seed_demo_project --with-personas`) and sign in as **`carlos`** — the executive persona (password `demo`) — then look over their shoulder or have them screen-share.

1. **Open the Overview.** Look at the forecast. It should read as a *range with a confidence level* — "80% likely by this date" — not a flat "on track / off track." A forecast that won't admit uncertainty is the one that embarrasses you later.
2. **Ask one question:** *did anyone build this by hand?* No — it's computed from the live plan. That's the whole difference from the two-day Excel ritual.
3. **Find the date you'd actually quote.** P80 is the defensible number to take to the board; P50 is the optimistic one most tools show as "the date."

Then judge it the way you actually decide. The technology is open and self-hosted, so your data never leaves your network. The two things you'd most want next — a one-glance portfolio dashboard and a weekly risk digest pushed to your inbox — are honestly still ahead (see "What's coming"); the portfolio view is an enterprise capability, and a single-program health digest is planned for 0.8. If either is a dealbreaker for you today, that's a fair call to make now rather than after rollout.

For the deeper architecture and roadmap behind a buying decision, see the [architecture overview](/architecture/overview/) and the [roadmap](/overview/roadmap/).
