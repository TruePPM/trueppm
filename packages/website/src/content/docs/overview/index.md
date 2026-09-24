---
title: Platform Overview
description: What TruePPM is, who it's for, and how the open-core model works.
documentedFor: "0.4"
---

TruePPM is an open-core Project, Program, and Portfolio Management (P3M) platform built for teams that run **waterfall, agile, and hybrid programs** — all from a single data model.

Most P3M tools force a choice: Jira speaks Agile and translates poorly to a schedule; MS Project speaks Waterfall and ignores the team's actual cadence. TruePPM is built so a Scrum Master and a Project Manager look at the same underlying data, and each sees the view they need. The translation happens inside the tool, not in a spreadsheet.

:::caution[0.4 shipped (beta) · pre-GA]
TruePPM 0.4 shipped September 15, 2026 (as the `v0.4.0-beta.1` pre-release) — the engine, API, real-time layer, web UI (Schedule, Board, Sprints, Risk, My Work, Programs), settings/administration platform, program foundations, the agile-team feature set, a read-only MCP server, basic single sign-on, and in-app time capture and baselines are all functional. 0.4 is TruePPM's first beta: the release line leaves alpha here and hardens under further `beta.N` tags before an eventual `0.4.0` stable. The product is pre-GA: expect API contract changes across 0.x point releases and a stable contract from 1.0 onward. Suitable for evaluation and early-adopter deployments.
:::

## Who this fits today

TruePPM fits a **50–2,000 task software or IT program, run by one PM plus an agile team, self-hosted, that wants a computed forecast** instead of a spreadsheet or a Gantt chart nobody trusts. That upper bound is not a guess — it is where the Schedule view stops opening comfortably in the [tested envelope](/administration/sizing/#tested-envelope), and it moves as the scale work on [#3383](https://gitlab.com/trueppm/trueppm/-/issues/3383) lands in 0.5.

It does not yet fit a construction, EPC, defense, or other contractually-scheduled program. TruePPM honors one schedule constraint type, has no resource leveling, and its tested scale sits two orders of magnitude below what those programs run day to day — see [what TruePPM doesn't do yet](/overview/what-it-does-not-do/) for the full, maintained list those limits are drawn from. If your plan carries a DCMA 14-point or NEC clause 31/32 obligation, or routinely runs tens of thousands of activities, TruePPM will not get you through a pilot yet.

This is a statement about fit, not about worth — the constraint is what gives the statement force, and we would rather say it here than have a pilot discover it.

## Core capabilities

**Critical Path Method scheduling.** Every time you create or change a task or dependency, TruePPM runs a full CPM pass — forward, backward, float calculation, and critical-path identification. All four dependency types (FS, SS, FF, SF), each with an optional lead/lag. You always know which tasks drive your deadline and where you have slack.

**Monte Carlo risk analysis.** Add three-point estimates to any task and run a probabilistic simulation. Get P50, P80, and P95 completion dates. The CPM finish date is typically P50 — there's only a 50% chance you'll hit it. Commit to P80.

**Agile sprint workflows.** Full sprint lifecycle: plan → activate → close. Board view with WIP limits, velocity tracking, burndown charts, capacity preflight, and retrospective-to-backlog automation. The Scrum Master gets a native agile surface and never needs to open a Gantt.

**Hybrid bridge.** The same task is both a WBS node and a sprint story. Sprint velocity feeds the CPM forecast through non-destructive duration suggestions the PM reviews and applies — and since 0.3, closing a sprint bound to a milestone writes a fresh P50/P80 forecast band around that milestone's CPM date. Estimates change only when the PM accepts a suggestion; the plan is never rewritten underneath them. No status meetings, no reconciliation spreadsheets.

**Real-time collaboration.** Every mutation is broadcast to connected clients over WebSocket, deferred to transaction commit so you never see phantom events from rolled-back writes.

**Offline sync protocol.** A WatermelonDB-compatible delta protocol with soft-delete tombstones, designed for mobile and unreliable networks — the installable PWA that consumes it ships in 0.5.

**5-role RBAC.** Owner, Admin, Scheduler, Member, Viewer — enforced per endpoint and per WebSocket connection.

## The eight personas

TruePPM is designed around eight roles that exist in real hybrid-delivery organizations:

| Persona | Role | Primary surface |
|---------|------|----------------|
| **Sarah** | Delivery / Program Manager | Schedule (Gantt), CPM, Monte Carlo |
| **Alex** | Delivery Lead — Scrum Master and agile coach | Board, Sprints, Velocity, Retrospective, team health signals |
| **Jordan** | Product Owner | Backlog management, velocity-based release forecasting, sprint scope protection |
| **Priya** | Team Member / Contributor | Board cards, Sprint backlog, My Work |
| **David** | Resource Manager | Capacity preflight, Allocation |
| **Marcus** | PMO Director / Portfolio Manager | Programs, Portfolio (Enterprise) |
| **Janet** | Executive Sponsor | Monte Carlo confidence, RAG status (Enterprise) |
| **Theo** | AI-Native Technical Operator | The read-only MCP server — questions to the live plan from an agent |

See [The Story](/the-story/) for an end-to-end walkthrough of how these roles interact on a real hybrid program.

## Open-core model

The **community edition** (Apache 2.0, this repository) includes everything an individual PM or program team needs:

- Scheduling engine (CPM + Monte Carlo), standalone on PyPI as `trueppm-scheduler`
- Schedule view (custom canvas Gantt — critical path, baseline comparison, milestones, drag-to-reschedule)
- Board / Kanban (5-column, WIP limit overload detection, drag-to-status)
- Sprints workspace (plan/activate/close, burndown, velocity, capacity preflight, retrospective)
- Agile reporting (burn charts, velocity calibration, multi-team lens)
- Programs (group related projects under one PM or program manager)
- MS Project import/export
- 5-role RBAC per project
- Real-time WebSocket collaboration
- Offline-first sync protocol (WatermelonDB-compatible)
- REST + WebSocket API (OpenAPI 3.0.3 schema)
- Helm 3 chart for Kubernetes deployment
- Integrations — [Jira Server/Data Center import](/features/jira-import/), a personal read-only Jira source for My Work, [GitLab and GitHub task links](/features/connected-accounts/) with live MR/PR/issue status, [Git-event board card automation](/administration/git-event-automation/), and [outbound webhooks](/features/webhooks/)

The **enterprise edition** (separate repository, proprietary) adds features for organizations governing a portfolio across multiple programs:

- Portfolio dashboard and health scores
- Org identity governance — SAML 2.0 federation, SCIM provisioning, LDAP/AD directory sync, enforced org-wide SSO (basic OIDC/OAuth login is included in the community core since 0.4)
- Immutable audit trail
- Cross-program resource leveling and capacity forecasting
- AI scheduling and scenario modeling
- Integration hub: org-wide, bidirectional Jira / GitLab / ServiceNow connectors with writeback and conflict resolution (Jira import, personal Jira and Git links, and Git-event automation are in the community edition)
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
