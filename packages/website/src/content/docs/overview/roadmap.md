---
title: Roadmap
description: What's shipped, what's underway, and what's planned through 1.0.
---

TruePPM is pre-GA. While the product is pre-1.0 we aim for **roughly monthly point releases** so adopters can plan against a predictable cadence. Dates below are targets, not commitments.

## Shipped

### 0.1 — first OSS release (May 2026)

Foundation for self-hosted, scheduling-first PPM. Everything below is in `main` and tagged.

| Surface | What landed |
|---------|-------------|
| Scheduling | CPM engine (4 dependency types, calendar-aware lag, cycle detection), Monte Carlo P50/P80/P95, auto-reschedule on every write, WASM CPM for sub-100ms drag preview |
| Schedule view | Custom canvas Gantt with critical path, baselines, milestones, unscheduled gutter, drag-to-reschedule, dependency editing UX (#249), design polish parity (#248) |
| Agile | Board / Kanban (5-column, swimlanes, WIP-overload), Sprints workspace (header + goal + milestone link + cadence + backlog + burndown + capacity + velocity + retro), multi-team Sprints lens, sprint header buttons (#299) |
| Hybrid bridge | Velocity feedback loop (`VelocitySuggestion` model, ADR-0065) — sprint velocity suggests revised CPM durations non-destructively |
| Contributor surface | "My Work" page — flat task list across projects with planned/estimated date disambiguation |
| Risk | Risk Register tab — probability × impact scoring, lifecycle states, task links, CSV import (#223) |
| Methodology | Waterfall / Agile / Hybrid preset driving tab visibility |
| Data exchange | MS Project import/export UI (#68), CSV/Excel import (#111), inbound task-sync webhook |
| Platform | REST API, 5-role RBAC, real-time WebSocket, offline sync (WatermelonDB-compatible), application shell, project settings RBAC UI (#144) |
| Operations | Helm 3 chart, Docker images, PyPI publish path for `trueppm-scheduler` (#301) |

## In progress

### 0.2 — settings, administration & consolidation (target: June 2026)

A broad consolidation release: the settings/administration platform, program foundations, board and schedule depth, and the first import/export migration paths.

- **Settings shell** — Workspace / Program / Project scope switcher with General, Members, Groups & teams, Roles, Methodology, Workflow, Notifications, Access, Integrations, and lifecycle pages on real APIs
- **Program entity (OSS)** (#502) — container for related projects with rollup KPIs, cadence, and cross-project risk policy; dual-level backlog (#501)
- **Import / export** — MS Project import/export UI (#68) plus `.mpp` parsing via MPXJ (#128), CSV/Excel spreadsheet import (#111), risk-register CSV import (#223)
- **Board depth** — card weight, bulk actions, full-text search, swimlane grouping, activity feed, PDF export, board zoom, real-time per-card sync
- **Schedule UX** — continuous zoom, drag-to-pan, drag a backlog card onto the timeline, per-task WebSocket date deltas
- **Sprint workspace**, recurring tasks, custom/fractional work hours, overallocation warnings
- **Durable execution** — outbox dispatch hardening, Beat heartbeat, dead-letter alerting, retention purge
- **Integrations & notifications** — Git-aware tasks (#637), Slack webhook (#638), email notifications (#639), notification dispatcher + preference matrix

## Planned

### 0.3 — hybrid depth + the launch demo (target: July 2026)

Rebalanced toward TruePPM's core thesis: prove the agile/waterfall bridge with real sample projects.

- **Hybrid bridge** — governance-class / delivery-mode model, parent rollup engine, agile-aware Monte Carlo, Kanban delivery mode, role-context switcher, percent-complete on duration change
- **Agile depth** — task-type taxonomy, epic/initiative hierarchy, dual backlog, Product Owner role, acceptance criteria, sprint planning / forecast / grooming views, mid-sprint scope protection, board sprint view
- **Sample projects + universal JSON import/export** (epic #613) — agile / waterfall / hybrid demo data sets with resources, risks, and walkthrough docs

### 0.4 — mobile, durability & baselines (target: August 2026)

- **Mobile** — React Native / Expo + WatermelonDB app, **Android phones first, Android tablets second** (iPhone deferred to 1.0 GA); My Tasks, 15-second time-entry capture, on-device WASM CPM, offline sync banners, store submission
- **Durable execution (ADR-0080)** — default workflow backend, backend-neutrality enforcement, Idempotency-Key support, webhook sequence numbers, workflow versioning, transactional mobile sync upload
- **Baselines** (#101) with structured rebaseline reasons, and a **timesheet system** (#100)
- **Offline hardening** — WebSocket event replay/resync, sync conflict detection, calm offline state, board offline
- **CPM-aware sprint bridge** (#372) — live finish-date forecast, incremental CPM recompute
- **MCP server** (LLM-facing read/write surface) and the notifications platform

### 0.5 — migration & data portability (target: September 2026)

- **Multi-format importers** (epics #624, #613) — top-10 PM tools (Jira, Asana, Monday, Wrike, ClickUp, Planview, Trello, Notion, Linear, Basecamp) plus Primavera P6 (XER/PMXML), OmniPlan, GanttProject, MPX/ProjectLibre — with an import-preview UX
- **Resource costs & cost reports**, custom 5/7-day work weeks, configurable fiscal year
- **Extension SDK** — custom fields, views, widgets, workflow actions, webhook events
- **Output** — Gantt PDF/image export, print/share view, multi-project roadmap, auto-narrative status report
- **OSS integration connectors** — calendar export, Drive/Box/Dropbox preview, meeting links

### 1.0 — first stable release

The marquee differentiator: **Team Cohesion** — a Brooks'-Law friction coefficient that feeds Monte Carlo, making TruePPM the first PPM tool to model team friction as a first-class scheduling input (epic #582). Plus **workflow-engine maturity** (ADR-0080: dead-letter, history API, idempotency hardening, observability, a second DBOS backend) and a pre-1.0 sample-project refresh.

Mobile completes here: **iPhone (and iPad) parity** — App Store submission, TestFlight, and iOS-side Detox parity on top of the Android codebase shipped in 0.4.

### 1.5 — Methodology Packs

Versioned phase bundles that slot into existing projects, with mechanical validation (cycle detection, milestone reachability, role coverage) and a local pack registry (file / git / http sources). Epic #577.

Past 1.0 the OSS surface keeps growing — EVM on the Schedule view, cycle-time/throughput analytics on the board, sub-tasks and checklists on stories. The full backlog lives as open issues in GitLab.

## Planned (enterprise edition)

These features live in a separate proprietary repository and overlay the OSS core:

- Portfolio dashboard and health scores
- Demand intake and prioritization workspace
- Cross-program resource leveling
- CCPM (Critical Chain Project Management)
- Resource heat map (cross-portfolio)
- Schedule forensics (narrative change detection)
- SSO/SAML/OIDC and LDAP sync
- Immutable audit trail
- Custom roles and approval workflows
- Jira / GitLab / ServiceNow connectors (git integration hub — 0.2)
- AI scheduling and scenario modeling
- Portfolio Monte Carlo
- Multi-tenancy and HA deployment
- Methodology Marketplace (1.5) and Automated Cohesion Inference (2.0)
