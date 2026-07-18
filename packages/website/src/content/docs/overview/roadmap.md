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
| Scheduling | CPM engine (4 dependency types, calendar-aware lag, cycle detection), Monte Carlo P50/P80/P95, auto-reschedule on every write, sub-100ms in-browser drag preview via a TypeScript CPM worker (calendar-approximate — fixed Mon–Fri week; the authoritative server CPM reconciles exact dates on commit). A Rust/WASM CPM engine ships as a conformance reference validated against the Python engine in CI (ADR-0015); wiring it into the browser is future work (#1777) |
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

### 0.3 — the agile team (alpha: Jun 28, 2026)

**For the Scrum Master and the self-managing developer.** Close a sprint and the master schedule reforecasts itself; merge a PR and the card moves and the dates shift — an agile board as good as the one you have now, with a CPM schedule quietly underneath.

Shipped as the **0.3.0-alpha.1** pre-release (tagged Jun 28, 2026), with `trueppm-scheduler` published to PyPI at **0.3.0a1**. Everything below is in `main` and tagged. The release line stays alpha through 0.3, and 0.4 is planned as the first beta.

- **First-class sprint model** — a real sprint *container* (goal, capacity, start/end, burndown) with **state-aware planning and closed views** (sprint-goal + advancing-milestone bridge banner, capacity preflight, carryover preview, sprint outcome cards, retro snapshot), not a board with date columns; auto-computed velocity with a forecast *range*; WIP-overload signal
- **Sprint sovereignty** — mid-sprint scope changes require a deliberate, audited decision; velocity stays a team metric and is never auto-exposed as a management gauge; retro action items flow into the next sprint's backlog
- **The bridge demo** — promote a sprint commitment to a schedule milestone, and sprint velocity reforecasts the CPM finish with no copy-paste between tools
- **Agile depth** — task-type taxonomy, epic/initiative hierarchy, dual backlog, Product Owner role, acceptance criteria, sprint planning / forecast / grooming views
- **Hybrid foundation** — governance-class / delivery-mode model, parent rollup engine, agile-aware Monte Carlo, Kanban delivery mode
- **Sample projects + universal JSON import/export** (epic #613) — agile / waterfall / hybrid demo data with the bridge wow preloaded
- **The v2 interface refresh** (epic #1163) — the navy/sage design system, a single unified app-shell bar (ADR-0134) with a ⌘K command palette, grouped methodology-adaptive view tabs, a context bar with presence and live health drill-through, role-based landing, and a context-aware "+ New". The visual and navigation overhaul shipped alongside the agile-team features rather than as a separate release; it is claimed here so the 0.3 charter matches what landed

## Underway

From 0.3 onward each release **lands one primary persona** — it ships the feature that turns that persona from interested into advocate — while the hybrid agile/waterfall bridge deepens underneath. The sequence expands by org scope: an agile team first, then the field PM, the people who staff the work, the product owner, and finally the program that ties projects together. Everything here is OSS; portfolio governance stays in the enterprise edition (below) and is intentionally absent until after 1.0. We ship a new release every 3–4 weeks — the cadence is part of the commitment, so adopters can plan against it.

### 0.4 — the self-hosting PM's beta (target: Jul 27 – Aug 3, 2026)

**For the project manager whose schedule lives on their own infrastructure — and TruePPM's first beta release.** The headliner is a read-only MCP server: point any MCP client (Claude Desktop, Cursor, Zed) at your self-hosted instance and ask real questions of the live schedule — critical path, a non-mutating Monte Carlo what-if, sprint status — all computed by the CPM engine, never guessed by a model, never leaving your box. That is the principle we call [**computed, not guessed**](/architecture/overview/#computed-not-guessed), and it is the spine of the MCP launch and of everything AI-facing that follows it. Because a beta is judged in its first five minutes, 0.4 is also where TruePPM becomes trivially evaluable: a hosted read-only demo, a one-command trial path, and read-only share links that let a schedule travel beyond its own instance — the evaluation story that stands in for a mobile app until the installable PWA lands in 0.5 and the native Android app in 0.6. And it lands the production foundations the self-hosting community expects at beta: SSO login federation, OpenTelemetry observability, a published rate-limiting and API-stability contract, and a coexistence-first inbound Jira sync so a team can adopt without abandoning the tools they already use.

:::tip[SSO is not an enterprise feature]
Basic single sign-on ships in the **OSS core** at 0.4. The carve-out line is one sentence:
**log in via your own IdP → OSS; provision, deprovision, and govern accounts from a directory →
Enterprise.** Point TruePPM at Keycloak, Authentik, Authelia, Zitadel, Google, GitHub, or GitLab
and your whole team logs in through it — no plugin, no paid tier. The enterprise edition earns its
price on identity *governance* (SAML 2.0, SCIM, LDAP/AD directory sync, enforced org-wide SSO), not
on the login screen. See [SSO Is Not an Enterprise Feature](/overview/sso-is-not-enterprise/) for
the full carve-out and a dated comparison against the open-core competition.
:::

:::note[Computed, not guessed — the AI contract]
Every AI-facing feature on this roadmap is one capability with four parts, maturing together
across releases rather than as scattered line items:

- **Compute** — engine-calculated answers, never a model's guess: the deterministic engine
  (shipped) and the read-only MCP server (**0.4**).
- **Cite** — a server-side derivation the agent quotes: the provenance graph (#1058, **0.4**).
- **Refuse** — the engine rejects any change that breaks the plan's rules, identically for
  humans and agents: feasibility refusal is in the engine today; agent **plan mode** —
  `dry_run` proposals answered with verdict + impact, committing nothing — lands at **0.5**
  (#1813), and the committing write path at **0.6** (#1062).
- **Reproduce** — every answer and refusal is attributable and re-derivable: the Phase-0
  agent-action audit foundation (hash-chained record + `audit_verify`, [ADR-0112](/architecture/decisions/)
  Accepted) **lands with this beta** and is already in `main`; a signed answer stamp follows at
  **0.9** (#1065).

See [Computed, not guessed](/overview/computed-not-guessed/) for the full principle.
:::

- **Read-only MCP server** *(headliner)* (#503 #504 #603) — point any MCP client (Claude Desktop and the like) at your self-hosted instance and ask real questions of the live schedule: critical path, a non-mutating Monte Carlo what-if ("slip this task three days — when do we ship?") with feasibility surfaced over the MCP tool (#1663), sprint status and velocity, the risk register, and My Work. Every answer is computed server-side by the same CPM/Monte Carlo engine the UI uses — never an LLM guess, never leaving your box. This is the principle we call [**computed, not guessed**](/architecture/overview/#computed-not-guessed), and it is the spine of everything AI-facing on this roadmap. Per-team token scopes keep sprint internals private. Read-only by design; agent plan mode (`dry_run` proposals — verdict + impact, nothing commits) follows at 0.5, and committing write tools are deliberately held to 0.6. The server ships listed in the MCP registries and client directories at launch (#1485), so TruePPM is discoverable from the agent ecosystem, not just from PPM searches
- **Core-flow delight** (#1666) — repair the primary schedule editing loop so the beta feels finished: a working drag-to-link affordance between tasks and Enter-to-add-row on the schedule, the two interactions an evaluator hits in the first minute
- **Basic single sign-on (OIDC / OAuth2)** — point TruePPM at your own identity provider (Keycloak, Authentik, Authelia, Zitadel, Google, GitHub, GitLab) and your whole team logs in through it. Self-hosted, login-only, no directory required — the federation a self-hoster expects as table stakes, not behind a paywall. The org identity-*governance* layer (SAML 2.0, SCIM provisioning, LDAP/AD directory sync, enforced org-wide SSO) stays in the enterprise edition. [**SSO is not an enterprise feature**](/overview/sso-is-not-enterprise/) — the positioning page makes that line explicit and compares it against the open-core competition (#1483)
- **OpenTelemetry observability** (#707–#710) — opt-in OTLP export for traces and metrics across Django, Celery, Channels, the DB layer, and the scheduler engine. Telemetry leaves the box over OTLP only; Prometheus-native stacks scrape it through an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) prometheus exporter, not a first-party `/metrics` endpoint — one deliberate, opt-in egress with no always-on scrape surface. Plug TruePPM into your existing Grafana/Jaeger/Tempo stack with no custom exporter work
- **API rate limiting &amp; stability contract** (#1080) — published per-endpoint rate limits with standard `Retry-After` headers, a documented deprecation policy, and a stability tier so integrators know what they can rely on across releases
- **Client-ready PDF** (#1436 #1437) — a basic Gantt-with-critical-path schedule export from day one (the rich reporting suite lands at 0.8)
- **Read-only share links** (#1486) — a tokenized, expiring, revocable public link to a schedule or board view: the PDF is for the meeting, the live link is for the follow-up. Read-only projection, rate-limited, with a workspace-level switch to disable public sharing entirely. This is how a self-hosted schedule travels beyond its own instance; the 0.6 shareable roadmap builds on the same token mechanism
- **Try before you install** (#1487) — a hosted read-only demo instance with the sample projects (and the bridge wow) preloaded, plus a one-command trial path leading the getting-started docs. The evaluation story starts here, not at the Helm chart
- **Inbound Jira, coexistence-first** (#1394 #1418 #1419) — continuous one-way, personal, read-only Jira → TruePPM card sync into My Work (distinct from the full one-time migration import, which lands at 0.5) so contributors never double-enter. Run TruePPM alongside Jira and get the CPM forecast without asking the team to switch first. Paired with a minimal computable Jira import (#1664) that turns issues into a CPM-schedulable network, and a write-parity + cycle guard (#1665) that validates any agent- or importer-generated task graph before it touches the schedule
- **Offline hardening** — WebSocket event replay/resync, sync conflict detection, calm offline states
- **Provenance and the audit foundation** (#1058, #1805) — the *cite* and *reproduce* halves of the AI contract, both landing with this beta and already merged to `main`. **Provenance** (#1058) gives every computed date, float, and P80 the server-side derivation an agent cites, so an answer is explainable, not asserted. The **agent-action audit foundation** (#1805, [ADR-0112](/architecture/decisions/) Accepted) records every agent read and every verdict — actor, decision, engine version — in a hash-chained, `audit_verify`-checkable log, with an `identity`/`policy` refusal taxonomy from day one; it makes *computed, not guessed* reproducible rather than merely claimed. An **agent-oversight panel** in the admin UI (#2020) surfaces that record to humans — what agents did, what was refused, and why — so oversight is something a team can see, not just something that was recorded. The rest of the AI-native foundation — a local natural-language query layer (#1060) and a bring-your-own local-model adapter (#1061) — moves to 0.5 alongside the decision &amp; forecast memory, keeping the beta focused on its MCP and evaluation headliners

## Planned

### 0.5 — plan & people (target: Sep 21–28, 2026)

**For the resource manager — and anyone who has to staff a plan, whether the workers are people, or people and AI agents.** The tool warns you'd put someone at 130% *before* you save the assignment, not six weeks later from a burned-out engineer — and the same allocation model takes its first step toward treating an AI agent as a schedulable resource, because for software teams "who does the work" now spans both. Resource allocation and the hybrid human/AI first cut share one engine seam (a worker profile on the resource), so they land together as one story rather than two features. The window was pushed back four weeks from the original target to give the 0.4 beta room to land and gather feedback before the next cycle opens. The native Android app moves out of this release to **0.6** — the installable PWA below is 0.5's mobile story — so the milestone concentrates on the staffing charter instead of opening a greenfield native platform alongside it.

- **Installable PWA** *(moved from 0.4)* (#1393) — a full installable progressive web app with an offline-capable shell: add to home screen on iOS or Android, time-entry and board reads work without a signal, and a reconnect banner syncs queued writes when connectivity returns. This is 0.5's mobile story — the native Android app follows in 0.6 — and the 0.4 beta uses the hosted read-only demo as its evaluation story instead
- **Push-notification foundation** (#2132) — service-worker push with a per-user opt-in lands alongside the PWA shell. Its first payload is agent **refusal alerts** — the oversight panel's signal, carried to the phone — and the same plumbing becomes the *approval remote* when the 0.7 change-request queue lands: approve or decline an agent's proposed change from your pocket, projected impact attached
- **First-run onboarding** *(moved from 0.4)* (#725) — a guided setup rail that walks a fresh install from empty dashboard to a running project with real tasks and a schedule: project creation, first task, team invite, and a live-preview mini-board. The full GA-polish pass happens at 0.9; this is the on-ramp that lets a self-hoster be productive in the first session

- **Resource allocation** — partial (e.g. 60/40) assignments per person per project, against a committed-capacity ceiling
- **Pre-commit conflict warning** — over-allocation surfaced before the booking is confirmed, plus a 90-day "what if we hire one more" capacity model
- **Hybrid human/AI scheduling — first cut** *(co-headliner)* (#1834 #1835 #1836) — the first step toward representing AI agents as first-class *resources*, for software teams whose work now runs across people and agents. The engine will separate **effort** (work content) from **duration** (elapsed time) so an agent's throughput and round-the-clock availability no longer have to masquerade as an 8-hour human day (#1835); a worker profile on the resource will carry agent throughput, concurrency, and review capacity (#1836, extending the resource-allocation model above); and a **team-owned review-gate read** (#1834) will surface when a team's own review queue — not authoring — has become the bottleneck. That queue signal is a team signal by design: team-owned, opt-in to roll upward, never a management surveillance surface ([team ownership is not surveillance](/overview/team-ownership-not-surveillance/)). The engine depth — sub-day scheduling and the probabilistic human-fallback branch — follows in 0.6
- **Timesheets** (#100) — actuals captured alongside the allocation they belong to
- **Baselines** (#101) — with structured rebaseline reasons
- **Get your data in** *(pulled forward from 0.6)* — CSV/Excel spreadsheet import with column-mapping preview (#111 → #743 #746) and a one-time Jira migration import (#627). Switching tools is not a persona — it is the funnel stage every persona passes through, and a resource manager can't staff a plan that still lives in a spreadsheet. 0.6 keeps the top-10 breadth and the preview polish
- **i18n framework decision** (#728, moved up from 0.9) — decide string externalization while the UI surface is still small; the self-hosting community is heavily international, and retrofitting extraction gets more expensive every release. Translations themselves can follow after GA
- **Decision & forecast memory** (#1059) — rebaseline reasons, scope-change decisions, and retro actions become a structured, queryable store, so the team — and any agent reasoning over the plan later — has the *why* behind every change, not just the what (cross-program calibration of that history stays enterprise)
- **AI query layer & local-model adapter** (#1060 #1061) — a local natural-language layer that compiles a question into engine calls (never into an answer) and a bring-your-own local-model adapter so the AI runs against a self-hosted model and nothing — plan or inference — leaves your box. The model translates, the engine answers — *computed, not guessed*, applied to natural language. Co-located here with the decision &amp; forecast memory so the AI-native foundation matures as one body of work after the 0.4 provenance graph
- **MCP plan mode — the agent dry run** *(pulled forward from 0.6)* (#1813) — the safest slice of the agent write path, shipped a release early because it commits nothing: an agent submits a **proposed** change over MCP with `dry_run` and the engine answers with the verdict, the constraints that fired, and the projected schedule impact — new critical path, date deltas, or a feasibility refusal with its derivation. The *refuse* verb reaches the write side with zero mutation risk, gated by the **same rulebook as human writes** (sprint sovereignty, phase locks, graph validation) — no agent side door. Builds on the 0.5 agent service accounts (#1811) and the audit foundation already in `main`; the committing write surface, engine-as-referee enforcement, and standing subscriptions complete the path at 0.6
- **Workshop facilitation core** (#1396 #1397) — a shared timer and dot voting on the Live Retro Board, riding the existing realtime channel with no new trust surface; the full collaborative-canvas shell (Excalidraw, guest links) follows at 0.7 (#1281)
- **Deep CPM-aware bridge** (#372) — live finish-date forecast and incremental CPM recompute, reconciling sprint capacity with the schedule
- **Durable execution (ADR-0080)** — default workflow backend, workflow versioning, transactional mobile sync upload
- **Agile-team refinements (continued from 0.3)** — sprint, board, and hybrid-bridge polish rebalanced out of the 0.4 beta so the beta stays focused on its MCP and evaluation headliners. These keep maturing the Scrum-Master and Product-Owner surfaces; not all are committed to the 0.5 date — the milestone is the holding line for this work, to be re-triaged against the 0.5 charter

### 0.6 — open & portable (target: Oct 19–26, 2026)

**For the team switching off another tool — and the builder who wants to drive TruePPM from code or an AI agent.** Get your data in, get it out, automate it from anywhere — and put the schedule in your pocket: the native Android app ships here as a co-headliner.

- **Native Android app** *(moved from 0.5 — a hard commitment at this release: the 1.0 iPhone/iPad parity work builds directly on this codebase, so it cannot slip again)* — React Native / Expo + WatermelonDB; My Tasks, 15-second time capture, on-device WASM CPM, offline sync, Play Store submission. Android phones first, tablets second; iPhone ships at 1.0. Until it lands, the 0.5 installable PWA is the offline mobile story
- **Multi-format import with preview** (epics #624, #613) — top-10 PM tools (Jira, Asana, Monday, Wrike, ClickUp, Planview, Trello, Notion, Linear, Basecamp). CSV/Excel and the one-time Jira migration land earlier, at 0.5 — 0.6 adds the breadth and the preview polish, and the specialist long-tail (Primavera P6 XER/PMXML, OmniPlan, GanttProject, MPX/ProjectLibre — #630–#635) follows at 0.7 so this release keeps its focus on Android and the write surface
- **MCP write surface** (#505 #604) — write tools (create/update task, move card, log time, update status), session auth, and broader surface coverage layered on top of the read-only MCP server that lands in 0.4, with read restrictions on sprint-internal fields so automation never becomes surveillance
- **Safe agent writes** — the write path lands **on top of the audit foundation already in `main`** (the *reproduce* substrate from 0.4), so an agent can act without wrecking the plan: an **engine-as-referee** (#1062) that refuses any write which would create an impossible schedule — the committing side of the plan-mode `dry_run` that ships at 0.5 — **agent-as-audited-actor** scoping (#1063) that extends the landed audit record with a capability-scoped actor identity, and **standing subscriptions** (#1064) so an agent can be told "alert me when P80 crosses the committed date." Two more guarantees ship in the **same release as the write surface — non-negotiable ordering**: **agent write receipts** (#2133), so every committed agent write shows *by agent, on behalf of principal, with verdict and a link to the audit entry* right in the task activity feed and change history — no one should ever wonder whether a robot moved a date, or why — and **containment** (#1815): per-agent suspend, a global "pause all agents" switch, and basic rate ceilings, so the off-switch never trails the capability it controls. Organizational governance of those agents — immutable audit, approval workflows, spend budgets, anomaly auto-suspend — stays in the enterprise edition
- **Instance #2 — the open falsification** (#1998) — the one AI-native item that is *building*, not naming. Everything grounding-related above grounds a single domain: scheduling feasibility. This experiment expresses one concrete **non-scheduling** control — a DORA or data-residency rule — as an `Invariant` and runs it through the *same* verdict → refusal → audit path the scheduling checks use. If it refuses-with-derivation and writes a clean agent-action audit entry with no knowledge of tasks or schedules, the refusal pipeline generalizes and the domain-agnostic `Invariant → Verdict` registry becomes real; if it does not, we have learned the boundary cheaply. **Unproven by design** — the *attempt* is committed, the *outcome* is not: the spike runs time-boxed at the top of the 0.6 window, before the write surface lands, and produces a written result memo either way. If it passes, a domain-agnostic invariant registry follows at 0.7 (#2137); if it fails, we record "scheduling-specific by design" and move on. No public copy describes TruePPM as a general "grounding engine" until it passes
- **Agent-governance starter kit** (#2134) — a docs deliverable shipping the same week as the write surface: a sample agent-use policy, a RACI for agent operations, least-privilege token-scope templates, a staged rollout checklist (agents off by default → read-only Q&A → plan-mode dry runs → approvals → scoped writes), and a one-page data-flow diagram showing nothing leaves the instance boundary. Enablement is always configured as a relaxation, never as a safety setting
- **Public REST API depth** and JSON import/export
- **Read-only shareable roadmap** — a now/next/later + timeline view a PO can hand to a stakeholder, built on the 0.4 share-link token mechanism (#1486)
- **OSS integration connectors** — calendar export, Drive/Box/Dropbox preview, meeting links
- **Hybrid human/AI scheduling — engine depth** (#1837 #1838 #1839 #1840) — the engine work behind the 0.5 first cut. Sub-day scheduling will land in both the Python and WASM engines so a 20-minute agent task no longer rounds to a whole working day (#1838); a `delivery_mode="agent"` task class will carry a probabilistic **fallback-to-human** branch the Monte Carlo samples, so a plan honestly reflects "sometimes a human has to step in" (#1837); the Gantt will render agent work as a queue glyph rather than an invisible sub-hour bar (#1839); and three-register reporting will report human dates, agent effort and throughput, and the program's true unit — the length of the human-bound critical path (#1840). Portfolio-level agent governance — agent-ROI, cross-program leveling, org approval workflows — stays in the enterprise edition, after 1.0

### 0.7 — the product owner & the platform opens up (target: Nov 16–23, 2026)

**For the PO running a whole small product or company — and the release where the platform starts opening up.** Strategy to delivery on one surface: roadmap → backlog → sprint → ship. Alongside the PO charter, 0.7 formalizes the internal plugin architecture and dogfoods it with two deliberately different surfaces — the mindmap view and the collaborative-canvas shell — so the 0.9 Extension SDK graduates proven extension points, not hopeful ones.

- **Product roadmap surface** — editable now/next/later with release-target lanes per epic
- **Release planning** across sprints, with velocity-based delivery ranges
- **Backlog ↔ schedule reconciliation** matured, so the PO and PM never maintain two representations of the same work
- **Mindmap view** (#2093) — a third lens beside the Gantt (time) and the Board (flow): the live WBS as an editable node tree — a *projection, not a document*. Every node is a real task or phase row; a drag is a real reparent, Enter/Tab are real creates — there is never a second "map document" to reconcile. And because plan-mode's verdict machinery (0.5) sits underneath, a dragged branch is badged with the real schedule impact *before* the drop — no other mindmap knows what a restructure does to the finish date
- **Plugin architecture** (#2094) — formalize the *internal* slot registry (view tabs, drawer sections, widgets, settings pages, card badges, attachment types) that the enterprise edition already registers against — no public API promise yet; the points proven by the two dogfoods graduate to the 0.9 Extension SDK. Extending your own instance is OSS; governing extensions across an org (install approval, allow/deny policy, signed-plugin provenance) is enterprise
- **Collaborative canvas shell** (#1281) — the Excalidraw-based workshop surface (sticky notes, CRDT co-editing, anonymous guest links) on the shipped workshops substrate; the facilitation core — shared timer and dot voting — lands earlier, at 0.5, on the Live Retro Board. Canvas scenes are freeform *artifacts* attached to retros, sprints, and tasks; the mindmap remains the structured projection — a whiteboard never becomes a second place the plan lives
- **Change Requests** (#1312) — agent plan-mode proposals route to a **named approver** who sees the projected schedule impact and records a disposition on the audit chain — *change request, impact analysis, disposition*: the vocabulary every PMO already uses, applied to agent proposals. Approvals reach the phone through the 0.5 push foundation (#2132). A single approver is OSS; multi-step chains, delegated authority, and org-wide policy stay enterprise
- **Shadow (advisor) mode** (#2135) — a trust rung *below* plan mode: agents propose silently against the dry-run path and nothing surfaces except a weekly digest — what an agent would have suggested, and what the engine would have refused. Zero interaction risk; the on-ramp for teams not yet ready for interactive agents
- **Assumption & constraint log** (#2136) — decision memory (#1059) grows first-class assumptions and constraints, so a derivation can say "P80 is Oct 22, *assuming vendor delivery by the 3rd*" — and invalidating an assumption flags every forecast that cited it
- **Invariant registry** *(gated on the 0.6 instance-#2 result)* (#2137) — if the #1998 falsification passes, the shipped scheduling checks (graph validation, sprint sovereignty, phase locks) are lifted behind a domain-agnostic `Invariant → Verdict` registry with behavior-identical conformance tests, and the proven non-scheduling invariant ships as an experimental, feature-flagged policy check; if it fails, the issue closes as "scheduling-specific by design" and this capacity returns to PO depth
- **Importer long-tail** (#630–#635) — the specialist formats (Primavera P6 XER/PMXML, OmniPlan, GanttProject, MPX/ProjectLibre) moved out of 0.6 so the Android + write-surface release stays focused

### 0.8 — present & relate (target: Dec 14–21, 2026)

**For the traditional PM who reports upward and the program manager who runs related projects.** The exports stakeholders live on, and one view of how a program's projects inter-relate.

- **Auto-narrative: "why did the date move"** *(headliner)* — every status meeting exists to answer this question, and TruePPM answers it from the engine: the actual chain of changes behind a date move, computed from the provenance graph (#1058), not reconstructed from memory. Single-project narrative is OSS; cross-program schedule forensics stays enterprise
- **Agent activity in reporting** (#2138) — the auto-narrative and the status exports gain an *agents section*: what agents did this period, what was refused and why, computed from the audit chain (#1805) and provenance graph the same way the date-move narrative is. In a hybrid human/agent team the Monday status pack covers the whole workforce. Single-project is OSS; cross-program agent forensics stays enterprise
- **EV-lite** (#2139) — minimal earned value, pulled forward from post-1.0: PV/EV/AC with SPI/CPI, computed from baselines (0.5), timesheet actuals (0.5), and the cost data landing here — pure deterministic formulas over data the engine already owns, *computed, not guessed* applied to the most PMO-native numbers there are
- **Reporting & analytics** — Gantt PDF, print/share, what-if scenarios, baseline variance
- **Team Cohesion technical preview** (#1488) — the Brooks'-Law friction model publishes early as a technical post and an experimental flag, so the 1.0 marquee arrives publicly validated rather than asserted
- **Program web view** — one timeline across a program's projects, cross-project dependency lines, program rollup, single-program resource leveling, risk-slip propagation
- **Single-program health digest** — an opt-in read-only RAG email at the program level (cross-*program* portfolio rollups stay enterprise)
- **Resource costs & cost reports**, custom 5/7-day work weeks, configurable fiscal year

### 0.9 — GA candidate (target: Jan 11–18, 2027)

**For the first-time evaluator.** Productive in five minutes, and hardened enough to bet a program on.

- **Onboarding polish** — the "easier than MS Project / Planview / Smartsheet" promise audited end to end; the first-run setup rail (#725) ships at 0.5, this pass refines it to GA quality
- **Intuitiveness pass** — the "easier than MS Project / Planview / Smartsheet" promise, audited end to end
- **GA hardening** — public API v1 freeze, WCAG 2.1 AA audit, performance/scale validation, i18n/l10n execution per the framework decision made at 0.5 (#728) (rate limiting and API stability contract land at 0.4; this hardens the final v1 surface)
- **Reproducible answers** (#1065) — the *reproduce* verb's signed answer stamp, layered on the 0.4 agent-action audit foundation: computed responses carry an engine-version + input hash, so an AI-surfaced number can be reproduced and audited later from the same inputs — an answer you can re-run (the compliance archive of those answers is an enterprise overlay)
- **Audit & evidence export** (#2140) — the agent-action chain (JSON), answer stamps, and an `audit_verify` attestation join the data-export surface, frozen inside API v1. Deliberately the *raw* half of the evidence story: OSS ships complete, verifiable evidence data anyone can check; regulator-shaped packaging (DORA / SR 11-7 / AI-Act bundles, retention, legal hold) stays enterprise, building against this seam
- **Status snapshot archive** (#2141) — a monthly point-in-time archive of the status pack, sealed with the answer stamp: what we reported, and provably what we knew when we reported it — retrievable when someone asks in March what the plan said in November
- **Extension SDK** — custom fields, views, widgets, workflow actions, webhook events — graduating the extension points proven by the 0.7 plugin dogfoods (#2094)

### 1.0 — first stable release (target: Feb 22 – Mar 1, 2027)

The marquee differentiator: **Team Cohesion** — a Brooks'-Law friction coefficient that feeds Monte Carlo, making TruePPM the first PPM tool to model team friction as a first-class scheduling input (epic #582) — previewed publicly at 0.8 (#1488) so it lands validated, not asserted. Mobile completes here: **iPhone and iPad parity** — App Store submission, TestFlight, and iOS-side Detox parity on top of the Android codebase shipped in 0.6. Plus **workflow-engine maturity** (ADR-0080: dead-letter, history API, idempotency hardening, observability, a second DBOS backend) and a pre-1.0 sample-project refresh.

### 1.5 — Methodology Packs

Versioned phase bundles that slot into existing projects, with mechanical validation (cycle detection, milestone reachability, role coverage) and a local pack registry (file / git / http sources). Epic #577.

Past 1.0 the OSS surface keeps growing — deeper earned-value surfaces on the Schedule view (EV-lite itself lands at 0.8), cycle-time/throughput analytics on the board, sub-tasks and checklists on stories. The full backlog lives as open issues in GitLab.

## Planned (enterprise edition)

These features live in a separate proprietary repository and overlay the OSS core:

- Portfolio dashboard and health scores
- Demand intake and prioritization workspace
- Cross-program resource leveling
- CCPM (Critical Chain Project Management)
- Resource heat map (cross-portfolio)
- Schedule forensics (narrative change detection)
- Org identity governance — SAML 2.0 federation, SCIM provisioning, LDAP/AD directory sync, and enforced org-wide SSO (basic OIDC/OAuth login ships in the OSS core at 0.4)
- Immutable audit trail
- Custom roles and approval workflows
- Jira / GitLab / ServiceNow connectors (git integration hub — 0.2)
- AI scheduling and scenario modeling
- Portfolio Monte Carlo
- Multi-tenancy and HA deployment
- Methodology Marketplace (1.5) and Automated Cohesion Inference (2.0)
- **AI governance overlay** — the organizational counterpart to the OSS AI layer, registering against its extension points: immutable agent audit trail, approval workflows for agent writes, custom agent roles and capability policy, cross-program AI decision-memory and forecast calibration, portfolio AI scenario modeling, org-wide AI model-governance and data-egress policy, compliance evidence export for AI-assisted decisions, and bidirectional Integration-Hub AI-reconciliation
