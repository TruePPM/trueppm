---
title: Platform Overview
description: What TruePPM is, who it's for, and how the open-core model works.
---

TruePPM is an open-core Project, Program, and Portfolio Management (P3M) platform built for teams that run **waterfall, agile, and hybrid programs** — all from a single data model.

Most P3M tools force a choice: Jira speaks Agile and translates poorly to a schedule; MS Project speaks Waterfall and ignores the team's actual cadence. TruePPM is built so a Scrum Master and a Project Manager look at the same underlying data, and each sees the view they need. The translation happens inside the tool, not in a spreadsheet.

:::caution[0.1 shipped · pre-GA]
TruePPM 0.1 shipped in May 2026 — the engine, API, real-time layer, and web UI (Schedule, Board, Sprints, Risk, My Work) are all functional. The product is pre-GA: expect API contract changes across 0.x point releases and a stable contract from 1.0 onward. Suitable for evaluation and early-adopter deployments.
:::

## Core capabilities

**Critical Path Method scheduling.** Every time you create or change a task or dependency, TruePPM runs a full CPM pass — forward, backward, float calculation, and critical-path identification. All four dependency types (FS, SS, FF, SF) with calendar-aware lag. You always know which tasks drive your deadline and where you have slack.

**Monte Carlo risk analysis.** Add three-point estimates to any task and run a probabilistic simulation. Get P50, P80, and P95 completion dates. The CPM finish date is typically P50 — there's only a 50% chance you'll hit it. Commit to P80.

**Agile sprint workflows.** Full sprint lifecycle: plan → activate → close. Board view with WIP limits, velocity tracking, burndown charts, capacity preflight, and retrospective-to-backlog automation. The Scrum Master gets a native agile surface and never needs to open a Gantt.

**Hybrid bridge.** The same task is both a WBS node and a sprint story. Sprint velocity automatically feeds the CPM forecast. When a team member marks a story done, the PM's Gantt re-forecasts in real time. No status meetings, no reconciliation spreadsheets.

**Real-time collaboration.** Every mutation is broadcast to connected clients over WebSocket, deferred to transaction commit so you never see phantom events from rolled-back writes.

**Offline-first sync.** A WatermelonDB-compatible delta protocol with soft-delete tombstones, designed for mobile and unreliable networks.

**5-role RBAC.** Owner, Admin, Scheduler, Member, Viewer — enforced per endpoint and per WebSocket connection.

## The eight personas

TruePPM is designed around eight roles that exist in real hybrid-delivery organizations:

| Persona | Role | Primary surface |
|---------|------|----------------|
| **Sarah** | Project Manager | Schedule (Gantt), CPM, Monte Carlo |
| **Alex** | Scrum Master / Agile Delivery Lead | Board, Sprints, Velocity, Retrospective |
| **Jordan** | Product Owner | Backlog management, velocity-based release forecasting, sprint scope protection |
| **Priya** | Team Member / Contributor | Board cards, Sprint backlog, My Work |
| **David** | Resource Manager | Capacity preflight, Allocation |
| **Marcus** | PMO Director | Programs, Portfolio (Enterprise) |
| **Janet** | Executive Sponsor | Monte Carlo confidence, RAG status (Enterprise) |
| **Morgan** | Agile Coach | Team health signals, Practice maturity |

See [The Story](/the-story/) for an end-to-end walkthrough of how these roles interact on a real hybrid program.

## Open-core model

The **community edition** (Apache 2.0, this repository) includes everything an individual PM or program team needs:

- Scheduling engine (CPM + Monte Carlo), standalone on PyPI as `trueppm-scheduler`
- Schedule view (custom canvas Gantt — critical path, baselines, milestones, drag-to-reschedule)
- Board / Kanban (5-column, WIP limit overload detection, drag-to-status)
- Sprints workspace (plan/activate/close, burndown, velocity, capacity preflight, retrospective)
- Agile reporting (burn charts, velocity calibration, multi-team lens)
- Programs (group related projects under one PM or program manager)
- MS Project import/export
- 5-role RBAC per project
- Real-time WebSocket collaboration
- Offline-first sync protocol (WatermelonDB-compatible)
- REST + WebSocket API (OpenAPI 3.1 schema)
- Helm 3 chart for Kubernetes deployment

The **enterprise edition** (separate repository, proprietary) adds features for organizations governing a portfolio across multiple programs:

- Portfolio dashboard and health scores
- SSO/SAML/OIDC and LDAP sync
- Immutable audit trail
- Cross-program resource leveling and capacity forecasting
- AI scheduling and scenario modeling
- Jira / GitLab / ServiceNow connectors
- Multi-tenancy

The community edition is fully functional on its own — it never imports from the enterprise repo. The dependency is strictly one-way: enterprise extends core.

**Rule of thumb:** The OSS unit is the **program** — one PM or program manager, one or more related projects. "Would a PM or their team need this to deliver their program?" → OSS. "Does this require governance across multiple programs?" → Enterprise.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Scheduling engine | Python 3.12+, networkx, numpy |
| API | Django 5.2, DRF 3.15, Django Channels 4 |
| Queue | Celery 5.4 + Valkey 8 (Redis-compatible) |
| Database | PostgreSQL 16 |
| Web UI | React 19, TypeScript, Vite 6, Tailwind CSS |
| Schedule (Gantt) | Custom canvas renderer (no third-party Gantt library) |
| Auth | django-allauth + simplejwt |
| Deploy | Helm 3 on Kubernetes |
