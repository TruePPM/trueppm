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

### 0.2 — settings depth + agile foundation (target: June 2026)

Closing the settings/admin gaps surfaced by the VoC audit, and the agile-foundation work that wasn't in 0.1's first cut.

- Retro → backlog pipeline UI surfacing (data model shipped in 0.1; #486)
- Acceptance criteria field on tasks
- Product backlog grooming view
- Workspace settings API (members, groups, general — #517 #518 #519)
- Project settings APIs (notifications #522, lifecycle delete/archive/transfer #530)
- Program settings APIs (rollup KPIs #527, risk policy #529)
- Connected accounts page (read-only IntegrationCredential list, ADR-0049 — #587)
- Settings UX cleanup from VoC audit (#537 #541 #588–#598)

## Planned

### 0.3 — Product Owner experience + MCP + cross-project (target: July 2026)

- Epic task type
- Sprint planning unified view
- PO release forecast
- Product Owner RBAC role
- MCP server (LLM-facing read/write surface)
- Cross-project dependencies + program burndown

### 0.4 — mobile + durability + baselines (target: August 2026)

- React Native mobile app — **Android phones first, Android tablets second** (iPhone deferred to 1.0 GA); read + simple updates, offline-capable via WatermelonDB
- Durable execution OSS primitives: backup, replay, conflict hardening (#320 #321 #322)
- Multi-baseline support with structured rebaseline reasons
- Time tracking (passive signals — commits, calendar — minimize manual entry)

### 0.5 — migration imports (target: September 2026)

- MS Project import/export improvements
- Primavera P6 (.xer) importer
- Third-party importers (GanttProject, Linear, Trello, Notion CSV)

### 1.0 — first stable release

The marquee differentiator: **manual Team Cohesion (Brooks' Law) slider** — the first PPM tool that models team friction as a first-class scheduling input (epic #582). Plus everything from 0.x stabilized for production support.

Mobile completes here: **iPhone (and iPad) parity** lands at 1.0 GA — App Store submission, TestFlight, and iOS-side Detox parity on top of the Android codebase shipped in 0.4.

Past 1.0, the OSS surface continues — EVM on the Schedule view, cycle-time/throughput analytics on the board, sub-tasks and checklists on stories. Methodology Packs land in 1.5. The full backlog lives as open issues in GitLab.

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
