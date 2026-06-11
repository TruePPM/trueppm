---
title: Roadmap
description: What's shipped, what's underway, and what's planned through 1.0.
---

TruePPM is pre-GA. While the product is pre-1.0 we ship a new point release **every 3–4 weeks** so adopters can plan against a predictable cadence. Dates below are targets, not commitments.

## Shipped

### 0.1 — first OSS release (May 2026)

Foundation for self-hosted, scheduling-first PPM. Everything below is in `main` and tagged.

| Surface | What landed |
|---------|-------------|
| Scheduling | CPM engine (4 dependency types, calendar-aware lag, cycle detection), Monte Carlo P50/P80/P95, auto-reschedule on every write, WASM CPM for sub-100ms drag preview |
| Schedule view | Custom canvas Gantt with critical path, milestones, unscheduled gutter, drag-to-reschedule, dependency editing UX (#249), design polish parity (#248) |
| Agile | Board / Kanban (5-column, swimlanes, WIP-overload), Sprints workspace (header + goal + milestone link + cadence + backlog + burndown + capacity + velocity + retro), multi-team Sprints lens, sprint header buttons (#299) |
| Hybrid bridge | Velocity feedback loop (`VelocitySuggestion` model, ADR-0065) — sprint velocity suggests revised CPM durations non-destructively |
| Contributor surface | "My Work" page — flat task list across projects with planned/estimated date disambiguation |
| Risk | Risk Register tab — probability × impact scoring, lifecycle states, task links (#174), CSV export (#222) |
| Methodology | Waterfall / Agile / Hybrid preset driving tab visibility |
| Data exchange | MS Project import/export via REST API — no in-app UI yet, inbound task-sync webhook |
| Platform | REST API, 5-role RBAC, real-time WebSocket, offline sync (WatermelonDB-compatible), application shell, project settings RBAC UI (#144) |
| Operations | Helm 3 chart, Docker images, PyPI publish path for `trueppm-scheduler` (#301) |

### 0.2 — settings, administration & consolidation (alpha: May 31, 2026)

A broad consolidation release — the settings/administration platform, program foundations, board and schedule depth, and the first import/export migration path. Shipped as the **0.2.0-alpha.1** pre-release (tagged May 31, 2026), with `trueppm-scheduler` published to PyPI at **0.2.0a1**. Everything below is in `main` and tagged. 0.2 is an alpha release — there is no separate stable 0.2.0. The release line stays alpha through 0.3, and 0.4 is planned as the first beta.

- **Settings shell** — Workspace / Program / Project scope switcher with General, Members, Groups & teams, Roles, Methodology, Workflow, Notifications, Access, Integrations, and lifecycle pages on real APIs
- **Program entity (OSS)** (#502) — container for related projects with rollup KPIs, cadence, and cross-project risk policy; program backlog with epic/feature/story/task item types and proposed→pulled→archived lifecycle (#733 #737 #739)
- **Import / export** — MS Project import/export UI (#68); multi-format import (CSV/Excel #111, MPXJ `.mpp` #128) is sequenced for 0.6 and risk-register CSV import (#223) for 0.3
- **Board depth** — card weight, bulk actions, full-text search, swimlane grouping, activity feed, PDF export, board zoom, real-time per-card sync
- **Schedule UX** — continuous zoom, drag-to-pan, drag a backlog card onto the timeline, per-task WebSocket date deltas
- **Sprint workspace**, recurring tasks, custom/fractional work hours, overallocation warnings
- **Durable execution** — outbox dispatch hardening, Beat heartbeat, dead-letter alerting, retention purge with UI editor and purge log, Idempotency-Key support, webhook sequence numbers
- **Integrations & notifications** — Git-aware tasks (#637), Slack webhook (#638), email notifications (#639), notification dispatcher + preference matrix
- **Packaging** — `trueppm-scheduler` published to PyPI at 0.2.0a1 (Development Status remains Alpha)

## Underway

From 0.3 onward each release **lands one primary persona** — it ships the feature that turns that persona from interested into advocate — while the hybrid agile/waterfall bridge deepens underneath. The sequence expands by org scope: an agile team first, then the field PM, the people who staff the work, the product owner, and finally the program that ties projects together. Everything here is OSS; portfolio governance stays in the enterprise edition (below) and is intentionally absent until after 1.0. We ship a new release every 3–4 weeks — the cadence is part of the commitment, so adopters can plan against it.

### 0.3 — the agile team (target: Jun 29 – Jul 6, 2026)

**For the Scrum Master and the self-managing developer.** Close a sprint and the master schedule reforecasts itself; merge a PR and the card moves and the dates shift — an agile board as good as the one you have now, with a CPM schedule quietly underneath.

- **First-class sprint model** — a real sprint *container* (goal, capacity, start/end, burndown) with **state-aware planning and closed views** (sprint-goal + advancing-milestone bridge banner, capacity preflight, carryover preview, sprint outcome cards, retro snapshot), not a board with date columns; auto-computed velocity with a forecast *range*; WIP-overload signal
- **Sprint sovereignty** — mid-sprint scope changes require a deliberate, audited decision; velocity stays a team metric and is never auto-exposed as a management gauge; retro action items flow into the next sprint's backlog
- **The bridge demo** — promote a sprint commitment to a schedule milestone, and sprint velocity reforecasts the CPM finish with no copy-paste between tools
- **Agile depth** — task-type taxonomy, epic/initiative hierarchy, dual backlog, Product Owner role, acceptance criteria, sprint planning / forecast / grooming views
- **Hybrid foundation** — governance-class / delivery-mode model, parent rollup engine, agile-aware Monte Carlo, Kanban delivery mode
- **Sample projects + universal JSON import/export** (epic #613) — agile / waterfall / hybrid demo data with the bridge wow preloaded

## Planned

### 0.4 — mobile & the field PM (target: Jul 27 – Aug 3, 2026)

**For the project manager on a job site with no signal — and TruePPM's first beta release.** A real native editor in your pocket — not a read-only viewer — so the schedule updates from the truck and the client PDF goes out before you drive back.

- **Mobile** — React Native / Expo + WatermelonDB, **Android phones first, tablets second** (iPhone at 1.0); My Tasks, 15-second time capture, on-device WASM CPM, offline sync, store submission
- **iOS PWA fallback** — a scoped mobile-web time-entry and read surface so iPhone users aren't blocked until 1.0 native
- **Client-ready PDF** — a basic Gantt-with-critical-path schedule export from day one (the rich reporting suite lands at 0.8)
- **Ongoing inbound sync** — continuous one-way Jira → TruePPM card sync (distinct from the one-time migration import at 0.6) so contributors never double-enter
- **Offline hardening** — WebSocket event replay/resync, sync conflict detection, calm offline states
- **Read-only MCP server** (#503 #504 #603) — point any MCP client (Claude Desktop and the like) at your self-hosted instance and ask real questions of the live schedule: critical path, a non-mutating Monte Carlo what-if ("slip this task three days — when do we ship?"), sprint status and velocity, the risk register, and My Work. Every answer is computed server-side by the same CPM/Monte Carlo engine the UI uses — never an LLM guess, never leaving your box. Per-team token scopes keep sprint internals private. Read-only by design; write tools are deliberately held to 0.6
- **AI-native foundation** — alongside the read-only MCP server, three pieces make the engine something an AI can *trust* rather than guess at: a **provenance graph** (#1058) so every computed date, float, and P80 carries the server-side derivation an agent can cite; a **local natural-language query layer** (#1060) that compiles a question into engine calls, never into an answer; and a **bring-your-own local-model adapter** (#1061) so the AI runs against a self-hosted model and nothing — plan or inference — leaves your box. The point of "evolve *with* AI": the same deterministic engine is just as useful whether your team queries it or your agents do

### 0.5 — plan & people (target: Aug 24–31, 2026)

**For the resource manager — and anyone who has to staff the plan.** The tool warns you'd put someone at 130% *before* you save the assignment, not six weeks later from a burned-out engineer.

- **Resource allocation** — partial (e.g. 60/40) assignments per person per project, against a committed-capacity ceiling
- **Pre-commit conflict warning** — over-allocation surfaced before the booking is confirmed, plus a 90-day "what if we hire one more" capacity model
- **Timesheets** (#100) — actuals captured alongside the allocation they belong to
- **Baselines** (#101) — with structured rebaseline reasons
- **Decision & forecast memory** (#1059) — rebaseline reasons, scope-change decisions, and retro actions become a structured, queryable store, so the team — and any agent reasoning over the plan later — has the *why* behind every change, not just the what (cross-program calibration of that history stays enterprise)
- **Deep CPM-aware bridge** (#372) — live finish-date forecast and incremental CPM recompute, reconciling sprint capacity with the schedule
- **Durable execution (ADR-0080)** — default workflow backend, workflow versioning, transactional mobile sync upload

### 0.6 — open & portable (target: Sep 21–28, 2026)

**For the team switching off another tool — and the builder who wants to drive TruePPM from code or an AI agent.** Get your data in, get it out, and automate it from anywhere.

- **Multi-format import with preview** (epics #624, #613) — top-10 PM tools (Jira, Asana, Monday, Wrike, ClickUp, Planview, Trello, Notion, Linear, Basecamp) plus Primavera P6 (XER/PMXML), OmniPlan, GanttProject, MPX/ProjectLibre
- **MCP write surface** (#505 #604) — write tools (create/update task, move card, log time, update status), session auth, and broader surface coverage layered on top of the read-only MCP server that lands in 0.4, with read restrictions on sprint-internal fields so automation never becomes surveillance
- **Safe agent writes** — the write surface lands with guardrails so an agent can act without wrecking the plan: an **engine-as-referee** (#1062) that rejects any write which would create an impossible schedule, **agent-as-audited-actor** scoping (#1063) with a team-readable record of everything an agent did, and **standing subscriptions** (#1064) so an agent can be told "alert me when P80 crosses the committed date." Organizational governance of those agents — immutable audit, approval workflows — stays in the enterprise edition
- **Public REST API depth** and JSON import/export
- **Read-only shareable roadmap** — a now/next/later + timeline view a PO can hand to a stakeholder
- **OSS integration connectors** — calendar export, Drive/Box/Dropbox preview, meeting links

### 0.7 — the product owner (target: Oct 19–26, 2026)

**For the PO running a whole small product or company.** Strategy to delivery on one surface: roadmap → backlog → sprint → ship.

- **Product roadmap surface** — editable now/next/later with release-target lanes per epic
- **Release planning** across sprints, with velocity-based delivery ranges
- **Backlog ↔ schedule reconciliation** matured, so the PO and PM never maintain two representations of the same work

### 0.8 — present & relate (target: Nov 16–23, 2026)

**For the traditional PM who reports upward and the program manager who runs related projects.** The exports stakeholders live on, and one view of how a program's projects inter-relate.

- **Reporting & analytics** — Gantt PDF, print/share, what-if scenarios, baseline variance, auto-narrative ("why did the date move")
- **Program web view** — one timeline across a program's projects, cross-project dependency lines, program rollup, single-program resource leveling, risk-slip propagation
- **Single-program health digest** — an opt-in read-only RAG email at the program level (cross-*program* portfolio rollups stay enterprise)
- **Resource costs & cost reports**, custom 5/7-day work weeks, configurable fiscal year

### 0.9 — GA candidate (target: Dec 14–21, 2026)

**For the first-time evaluator.** Productive in five minutes, and hardened enough to bet a program on.

- **First-run onboarding** — guided setup, first project, team invite
- **Intuitiveness pass** — the "easier than MS Project / Planview / Smartsheet" promise, audited end to end
- **GA hardening** — public API v1 freeze and rate limiting, WCAG 2.1 AA audit, performance/scale validation, i18n/l10n scope decision
- **Reproducible answers** (#1065) — computed responses carry an engine-version + input hash, so an AI-surfaced number can be reproduced and audited later from the same inputs (the compliance archive of those answers is an enterprise overlay)
- **Extension SDK** — custom fields, views, widgets, workflow actions, webhook events

### 1.0 — first stable release (target: Jan 18 – Feb 1, 2027)

The marquee differentiator: **Team Cohesion** — a Brooks'-Law friction coefficient that feeds Monte Carlo, making TruePPM the first PPM tool to model team friction as a first-class scheduling input (epic #582). Mobile completes here: **iPhone and iPad parity** — App Store submission, TestFlight, and iOS-side Detox parity on top of the Android codebase shipped in 0.4. Plus **workflow-engine maturity** (ADR-0080: dead-letter, history API, idempotency hardening, observability, a second DBOS backend) and a pre-1.0 sample-project refresh.

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
- **AI governance overlay** — the organizational counterpart to the OSS AI layer, registering against its extension points: immutable agent audit trail, approval workflows for agent writes, custom agent roles and capability policy, cross-program AI decision-memory and forecast calibration, portfolio AI scenario modeling, org-wide AI model-governance and data-egress policy, compliance evidence export for AI-assisted decisions, and bidirectional Integration-Hub AI-reconciliation
