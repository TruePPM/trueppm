---
title: For Executives
description: How TruePPM gives executive sponsors confidence-weighted forecasts they can trust — without learning the tool or waiting on a hand-built status report.
documentedFor: "0.4"
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
- Basic single sign-on (OIDC/OAuth against your own identity provider)
- An operational audit log of who changed what
- Read-only share links for a board or schedule, so stakeholders can see status without a login
- A read-only MCP server, so an agent can answer questions against the live plan

### API-driven reporting

The REST API provides full access to all project data — tasks, schedules, CPM (Critical Path Method) fields, members, resources. If your BI team needs to pull schedule data into a dashboard, the OpenAPI schema documents every endpoint.

## What's coming

The features most relevant to an executive sponsor are split across the community and enterprise roadmaps:

| Feature | Description | Edition |
|---------|-------------|---------|
| Portfolio dashboard | Health scores, RAG status across all projects | Enterprise |
| Demand intake | Prioritization workspace for project proposals | Enterprise |
| Cross-program coordination | Dependencies and alignment across multiple programs | Enterprise |
| Schedule forensics | Narrative detection of what changed and why | Enterprise |
| Basic single sign-on | OIDC/OAuth login against your own identity provider (shipped in 0.4) | Community |
| Org identity governance | SAML 2.0 federation, SCIM provisioning, LDAP/AD directory sync, enforced org-wide SSO | Enterprise |
| Immutable audit trail | Compliance-ready change history | Enterprise |
| Board-ready exports | Client-ready Gantt PDF (shipped in 0.4) and the reporting suite (planned for 0.8) | Community |
| Email/Slack notifications | Event notifications by email and Slack webhook shipped in 0.2; a single-program health digest is planned for 0.8 | Community |
| Portfolio digests | Proactive risk alerts and status summaries across the portfolio | Enterprise |

:::note[Why enterprise?]
These features require coordinating across multiple programs and enforcing governance at the portfolio level — which is the defining characteristic of the enterprise edition. The community edition handles everything a PM or program manager needs (including multi-project programs); the enterprise edition handles the portfolio and org-level governance layer on top.
:::

## Evaluate it yourself (~5 minutes, no login of your own)

You don't need to learn the tool to judge it — and you shouldn't have to. Hand this section to whoever set up the demo, sit next to them or have them screen-share, and watch.

**They run the setup:**

1. **Start the stack and seed the demo — load a ready-made sample program with one command.** From the TruePPM checkout:

   ```bash
   make up
   docker compose exec api python manage.py load_sample_project --with-personas
   ```

   The command prints the persona logins and their shared password when it finishes. On a local Docker stack (`DEBUG=True`) that password is `demo`; anywhere else it is `$TRUEPPM_DEMO_PASSWORD` if set, otherwise a random token printed once.

2. **They sign in as the program manager.** At `http://localhost:5173`, as **`atlas-alex`** — Alex Rivera, Program Manager, **Project Admin** on all three Atlas projects.

**Then you watch three things:**

3. **The forecast.** They open **Plan → Schedule** in the left navigation rail. The **Forecast** bar docked along the bottom is the answer: it reads as a *range with a confidence level* — P50 ≤ P80 ≤ P95 — not a flat "on track / off track." A forecast that won't admit uncertainty is the one that embarrasses you later.

4. **Where it came from.** Ask the one question: *did anyone build this by hand?* No — press **Details ›** and the tornado names the specific tasks and risks driving the spread, computed from the live plan. That's the whole difference from the two-day Excel ritual.

5. **The date you'd actually quote.** P80 is the defensible number to take to the board; P50 is the optimistic one most tools show as "the date."

Then judge it the way you actually decide. The technology is open and self-hosted, so your data never leaves your network. The two things you'd most want next — a one-glance portfolio dashboard and a weekly risk digest pushed to your inbox — are honestly still ahead (see "What's coming"); the portfolio view is an enterprise capability, and a single-program health digest is planned for 0.8. If either is a dealbreaker for you today, that's a fair call to make now rather than after rollout.

For the deeper architecture and roadmap behind a buying decision, see the [architecture overview](/architecture/overview/) and the [roadmap](/overview/roadmap/).
