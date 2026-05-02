---
title: Roadmap
description: What's available now, what's coming next, and what's planned for the enterprise edition.
---

TruePPM is pre-alpha. This page tracks what's built, what's in progress, and what's planned. For the latest, see the [GitLab issue board](https://gitlab.com/trueppm/trueppm/-/issues).

## Available now (community edition)

| Feature | Status | Details |
|---------|--------|---------|
| CPM scheduling engine | Stable | Forward/backward pass, all 4 dependency types, calendar-aware lag, cycle detection |
| Monte Carlo simulation | Stable | PERT-Beta distributions, P50/P80/P95, 10k runs on 200 tasks in <5s |
| REST API | Stable | Full CRUD for projects, tasks, dependencies, resources, calendars, members |
| 5-role RBAC | Stable | Owner / Admin / Scheduler / Member / Viewer, per-endpoint enforcement |
| Real-time WebSocket | Stable | Broadcasts for all mutations, deferred to transaction commit |
| Offline sync protocol | Stable | WatermelonDB-compatible delta sync with soft-delete tombstones |
| Auto-scheduling | Stable | Celery recalculates CPM on every write, Redis-locked for idempotency |
| Schedule view (Gantt-style) | Stable | Canvas renderer with critical path, baselines, milestones, unscheduled gutter, drag-to-reschedule |
| Board / Kanban | Stable | 5-column model, swimlanes, WIP limit overload detection, workshop mode |
| Sprints workspace | Stable | Header + goal + milestone link + cadence timeline + backlog + burndown + capacity + velocity + retro |
| Multi-team Sprints lens | Stable | Aggregated active-sprint health for users with assignments across projects |
| Methodology preset | Stable | Tab visibility per Waterfall / Agile / Hybrid choice |
| Application shell | Stable | Top bar, collapsible sidebar, status bar, mobile bottom nav, login |
| Helm chart | Draft | Kubernetes with Bitnami sub-charts for PostgreSQL and Redis |

## In progress (0.1)

| Feature | Description |
|---------|-------------|
| Sprint header buttons | Filter popover, close confirmation + carry-over picker, timeline activate/edit (#299) |
| MS Project import UI | Backend implemented; web upload modal + export button pending (#68) |
| CSV / Excel import | Spreadsheet-to-schedule migration (#111) |
| Risk register CSV import | Bulk import for the Risk register (#223) |
| Project settings — RBAC management UI | Members + role assignment in-app (#144) |
| Schedule view design polish | Restore parity with target design (#248) and dependency editing UX (#249) |
| Release engineering | Helm chart + Docker images + PyPI publish path (#301) |

## Planned (community edition)

Past 0.1, the OSS surface continues to expand. Current priorities:

- WASM CPM on the client (incremental recompute for sub-100ms drag preview, ADR-0027)
- Time tracking (passive signals where possible — commits, calendar — per Tom's persona)
- Multi-baseline support with structured rebaseline reasons
- EVM (BCWS / BCWP / ACWP / CPI / SPI) on the Schedule view
- Sub-tasks and checklists on stories
- Cycle time and throughput analytics on the board
- Mobile app (React Native + WatermelonDB) — read + simple updates first
- Additional migration importers (Primavera P6 .xer, GanttProject, Linear, Trello, Notion CSV)

The full list lives as open issues in [the GitLab project](https://gitlab.com/trueppm/trueppm/-/issues).

## Planned (enterprise edition)

These features will live in a separate proprietary repository:

- Portfolio dashboard and health scores
- Demand intake and prioritization workspace
- Cross-project dependencies and resource leveling
- CCPM (Critical Chain Project Management)
- Resource heat map (cross-portfolio)
- Schedule forensics (narrative change detection)
- SSO/SAML/OIDC and LDAP sync
- Immutable audit trail
- Custom roles and approval workflows
- Jira / GitLab / ServiceNow connectors
- AI scheduling and scenario modeling
- Portfolio Monte Carlo
- Multi-tenancy and HA deployment
