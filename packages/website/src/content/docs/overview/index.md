---
title: Platform Overview
description: What TruePPM is, who it's for, and how the open-core model works.
---

TruePPM is an open-core Project, Program, and Portfolio Management (P3M) platform for teams that need reliable schedule control — not just task tracking.

Most project management tools let you draw bars on a timeline, but they don't calculate the critical path, don't tell you which tasks have float, and don't warn you when a dependency change pushes your delivery date. TruePPM does.

:::caution[0.1-alpha — not ready for production use]
This is the first public alpha. The scheduling engine, REST API, and real-time backend are solid. The web UI is functional but rough. Expect breaking API changes before the first beta. **Hold off on deploying for real teams until 0.1-beta.**
:::

## Core capabilities

**Critical Path Method scheduling.** Every time you create or change a task or dependency, TruePPM runs a full CPM pass — forward, backward, float calculation, and critical-path identification. All four dependency types (FS, SS, FF, SF) with calendar-aware lag.

**Monte Carlo risk analysis.** Add three-point estimates to any task and run a probabilistic simulation. Get P50, P80, and P95 completion dates. The CPM finish date is typically P50 — there's only a 50% chance you'll hit it. Commit to P80.

**Real-time collaboration.** Every mutation is broadcast to connected clients over WebSocket, deferred to transaction commit so you never see phantom events from rolled-back writes.

**Offline-first sync.** A WatermelonDB-compatible delta protocol with soft-delete tombstones, designed for mobile and unreliable networks.

**5-role RBAC.** Owner, Admin, Scheduler, Member, Viewer — enforced per endpoint and per WebSocket connection.

## Open-core model

The **community edition** (Apache 2.0, this repository) includes everything an individual PM or small team needs:

- Scheduling engine (CPM + Monte Carlo)
- Schedule (Gantt) UI
- REST + WebSocket API
- Real-time collaboration
- Offline sync protocol
- 5-role RBAC
- Helm chart for self-hosted deployment

The **enterprise edition** (separate repository, proprietary) adds features for organizations managing a portfolio across multiple programs:

- Portfolio dashboard and health scores
- SSO/SAML/OIDC and LDAP sync
- Immutable audit trail
- Cross-program resource leveling and capacity forecasting
- AI scheduling and scenario modeling
- Jira / GitLab / ServiceNow connectors
- Multi-tenancy

The community edition is fully functional on its own — it never imports from the enterprise repo. The dependency is strictly one-way: enterprise extends core.

**Rule of thumb:** The OSS unit is the **program** — one PM or program manager, one or more related projects. "Would a PM or program manager need this for their program?" → OSS. "Does this require portfolio-level coordination across multiple programs, or org-level governance?" → Enterprise.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Scheduling engine | Python 3.12+, networkx, numpy |
| API | Django 5.1, DRF 3.15, Django Channels 4 |
| Queue | Celery 5.4 + Redis 7 |
| Database | PostgreSQL 16 |
| Web UI | React 19, TypeScript, Vite 6, Tailwind CSS |
| Schedule (Gantt) | Custom canvas renderer (no third-party Gantt library) |
| Auth | django-allauth + simplejwt |
| Deploy | Helm 3 on Kubernetes |
