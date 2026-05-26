---
title: For Executives and PMO Directors
description: How TruePPM delivers portfolio visibility, confidence-weighted forecasting, and governance for leadership.
---

You need portfolio visibility at a glance — which projects are on track, which are at risk, and where resources are constrained. TruePPM is building toward that, but it's important to be transparent about what exists today versus what's on the roadmap.

## What's available now

### Confidence-weighted scheduling

Unlike traditional tools that show a single "planned finish date," TruePPM's Monte Carlo simulation produces probability distributions:

| Metric | Meaning |
|--------|---------|
| **P50** | 50% chance of hitting this date — where most tools stop |
| **P80** | 80% chance — **the date your team should commit to** |
| **P95** | 95% chance — contractual buffer |

This is available today, per project, via the scheduling engine and API. Your project managers can run Monte Carlo on any project with three-point estimates.

### Per-project RBAC

TruePPM enforces a 5-role model per project. As an executive, you can be added as a **Viewer** (role 0) to any project for read-only access, or as a **Member** (role 100) for slightly more access. This is enforced at the API level — no backdoors.

### Self-hosted, compliant by design

TruePPM runs on your infrastructure. No data leaves your network. The community edition supports:

- PostgreSQL for data storage (standard backup/recovery)
- Valkey (Redis-compatible) for real-time messaging (stateless, no persistent data)
- JWT authentication with configurable token lifetimes
- Helm chart for Kubernetes deployment

### API-driven reporting

The REST API provides full access to all project data — tasks, schedules, CPM fields, members, resources. If your BI team needs to pull schedule data into a dashboard, the OpenAPI schema documents every endpoint.

## What's coming

The features most relevant to executives and PMO directors are on the enterprise roadmap:

| Feature | Description | Edition |
|---------|-------------|---------|
| Portfolio dashboard | Health scores, RAG status across all projects | Enterprise |
| Demand intake | Prioritization workspace for project proposals | Enterprise |
| Cross-program coordination | Dependencies and alignment across multiple programs | Enterprise |
| Schedule forensics | Narrative detection of what changed and why | Enterprise |
| SSO/SAML/OIDC | Enterprise single sign-on | Enterprise |
| LDAP sync | Automatic user provisioning | Enterprise |
| Immutable audit trail | Compliance-ready change history | Enterprise |
| Board-ready exports | Formatted reports for executive presentations | Enterprise |
| Email/Slack digests | Proactive risk alerts and status summaries | Enterprise |

:::note[Why enterprise?]
These features require coordinating across multiple programs and enforcing governance at the portfolio level — which is the defining characteristic of the enterprise edition. The community edition handles everything a PM or program manager needs (including multi-project programs); the enterprise edition handles the portfolio and org-level governance layer on top.
:::

## Evaluating TruePPM

If you're evaluating TruePPM for your organization:

1. **Try the scheduling engine** — [install locally](/getting-started/installation/) and run the [quickstart](/getting-started/quickstart/). The CPM and Monte Carlo capabilities are the core differentiator.
2. **Review the architecture** — the [architecture overview](/architecture/overview/) explains how the pieces fit together and how the platform scales.
3. **Check the roadmap** — the [roadmap](/overview/roadmap/) shows what's built, what's in progress, and what's planned for each edition.
4. **Talk to us** — if the enterprise features are what you need, reach out via the GitLab repository to discuss timelines and early access.
