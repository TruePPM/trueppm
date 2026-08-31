---
title: Roadmap
description: What's shipped, what's underway, and what's planned through 1.0.
---

TruePPM is pre-GA and is built part-time. Through 1.0 we aim for a point release roughly **every 10–12 weeks** — we would rather publish a cadence we can hold than one that slips every cycle.

**This roadmap stops carrying dates after 0.5, deliberately.** 0.4 is the first release we have asked anyone to run a real project on. What those people report should set the order of everything after it — and until we have heard from them, a dated 2027 plan is a forecast built from our own assumptions and published at a precision we have not earned. We would rather say so than fill the gap with numbers.

- **0.4 and 0.5** carry a two-week delivery window. The target is the midpoint. The window says when in that fortnight the tag gets cut — it is not a claim that we are confident to ±7 days.
- **0.6** is named and scoped, but carries no date.
- **Everything beyond 0.6** sits under **Direction** below: committed in intent, uncommitted in position, unassigned in time. The full backlog lives in [GitLab](https://gitlab.com/trueppm/trueppm/-/issues).

Version numbers still appear past 0.6 where another page declares against one. Past 0.6 they record how work is currently sequenced in the tracker — a **sequence, not a schedule**.

## Shipped

:::note[What "Shipped" means here]
A version appears in this section once the release line reaches **the maturity that
version promises** — for 0.4, the first `beta` tag. Alpha prereleases on the way to
that milestone do not move it up.

0.1, 0.2, and 0.3 each promised an alpha and arrived as one (`v0.1.0-alpha.1`,
`v0.2.0-alpha.1`, `v0.3.0-alpha.1`), which is why they are listed here without the
line ever leaving alpha. 0.4 promises a beta, so it moves here at `v0.4.0-beta.1`
and not before — see [how the 0.4 line is numbered](#how-the-04-line-is-numbered).

Everything under this heading is in `main` and tagged. Anything that is not is under
[Underway](#underway) or [Planned](#planned), and the docs pages that describe it
carry a "Ships in 0.X" banner until the release lands.
:::

### 0.1 — first OSS release (alpha: May 2026)

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

A broad consolidation release — the settings/administration platform, program foundations, board and schedule depth, and the first import/export migration path. Shipped as the **0.2.0-alpha.1** pre-release (tagged May 31, 2026), with `trueppm-scheduler` published to PyPI at **0.2.0a1**. Everything below is in `main` and tagged. 0.2 is an alpha release — there is no separate stable 0.2.0. The release line stays alpha through 0.3, and 0.4 is planned as the first beta — arriving directly as `0.4.0-beta.1`, with no alpha step in between (see [how the 0.4 line is numbered](#how-the-04-line-is-numbered)).

- **Settings shell** — Workspace / Program / Project scope switcher with General, Members, Groups & teams, Roles, Methodology, Workflow, Notifications, Access, Integrations, and lifecycle pages on real APIs
- **Program entity (OSS)** (#502) — container for related projects with rollup KPIs, cadence, and cross-project risk policy; program backlog with epic/feature/story/task item types and proposed→pulled→archived lifecycle (#733 #737 #739)
- **Import / export** — MS Project import/export UI (#68); CSV/Excel import (#111) is sequenced for the 0.4 beta, MPXJ `.mpp` (#128) for 0.6, and risk-register CSV import (#223) shipped at 0.3
- **Board depth** — card weight, bulk actions, full-text search, swimlane grouping, activity feed, PDF export, board zoom, real-time per-card sync
- **Schedule UX** — continuous zoom, drag-to-pan, drag a backlog card onto the timeline, per-task WebSocket date deltas
- **Sprint workspace**, recurring tasks, custom/fractional work hours, overallocation warnings
- **Durable execution** — outbox dispatch hardening, Beat heartbeat, dead-letter alerting, retention purge with UI editor and purge log, Idempotency-Key support, webhook sequence numbers
- **Integrations & notifications** — Git-aware tasks (#637), Slack webhook (#638), email notifications (#639), notification dispatcher + preference matrix
- **Packaging** — `trueppm-scheduler` published to PyPI at 0.2.0a1 (Development Status remains Alpha)

### 0.3 — the agile team (alpha: Jun 28, 2026)

**For the Scrum Master and the self-managing developer.** Close a sprint and the master schedule reforecasts itself; merge a PR and the card moves and the dates shift — an agile board as good as the one you have now, with a CPM schedule quietly underneath.

Shipped as the **0.3.0-alpha.1** pre-release (tagged Jun 28, 2026), with `trueppm-scheduler` published to PyPI at **0.3.0a1**. Everything below is in `main` and tagged. The release line stays alpha through 0.3, and 0.4 is planned as the first beta — arriving directly as `0.4.0-beta.1`, with no alpha step in between (see [how the 0.4 line is numbered](#how-the-04-line-is-numbered)).

- **First-class sprint model** — a real sprint *container* (goal, capacity, start/end, burndown) with **state-aware planning and closed views** (sprint-goal + advancing-milestone bridge banner, capacity preflight, carryover preview, sprint outcome cards, retro snapshot), not a board with date columns; auto-computed velocity with a forecast *range*; WIP-overload signal
- **Sprint sovereignty** — mid-sprint scope changes require a deliberate, audited decision; velocity stays a team metric and is never auto-exposed as a management gauge; retro action items flow into the next sprint's backlog
- **The bridge demo** — promote a sprint commitment to a schedule milestone, and sprint velocity reforecasts the CPM finish with no copy-paste between tools
- **Agile depth** — task-type taxonomy, epic/initiative hierarchy, dual backlog, Product Owner role, acceptance criteria, sprint planning / forecast / grooming views
- **Hybrid foundation** — governance-class / delivery-mode model, parent rollup engine, agile-aware Monte Carlo, Kanban delivery mode
- **Sample projects + universal JSON import/export** (epic #613) — agile / waterfall / hybrid demo data with the bridge wow preloaded
- **The v2 interface refresh** — the navy/sage design system, a single unified app-shell bar (ADR-0134) with a ⌘K command palette, grouped methodology-adaptive view tabs, a context bar with presence and live health drill-through, role-based landing, and a context-aware "+ New" shipped alongside the agile-team features rather than as a separate release. The tracking epic (#1163) stays open past 0.3, though — it also carries the Risks-view redesign (filters/matrix/rollup), Gantt dependency hover-to-trace, task-detail drawer-to-full-page expansion, warm empty/first-run states, and the entitlement-aware Portfolio rollup gate, which are sequenced as conformance work through 0.7

## Underway

From 0.3 onward each release **lands one primary persona** — it ships the feature that turns that persona from interested into advocate — while the hybrid agile/waterfall bridge deepens underneath. The sequence expands by org scope: an agile team first, then the field PM, the people who staff the work, the product owner, and finally the program that ties projects together. Everything here is OSS; portfolio governance stays in the enterprise edition (below) and is intentionally absent until after 1.0. Point releases have been landing every 4–9 weeks so far (0.2 → 0.3 in four; 0.3 → 0.4 in seven to nine). Only 0.4 and 0.5 carry dates; the persona ordering past 0.6 is a sequence we intend, not a schedule we have committed to.

### 0.4 — the self-hosting PM's beta (target: Aug 17 – 31, 2026)

**For the project manager whose schedule lives on their own infrastructure — and TruePPM's first beta release.** The headliner is a read-only MCP server: point any MCP client (Claude Desktop, Cursor, Zed) at your self-hosted instance and ask real questions of the live schedule — critical path, a non-mutating Monte Carlo what-if, sprint status — all computed by the CPM engine, never guessed by a model, never leaving your box. That is the principle we call [**computed, not guessed**](/architecture/overview/#computed-not-guessed), and it is the spine of the MCP launch and of everything AI-facing that follows it. Because a beta is judged in its first five minutes, 0.4 is also where TruePPM becomes trivially evaluable: a hosted read-only demo, a one-command trial path, and read-only share links that let a schedule travel beyond its own instance — the evaluation story that stands in for a mobile app until the installable PWA lands in 0.5 and the native Android app in 0.6. And it lands the production foundations the self-hosting community expects at beta: SSO login federation, OpenTelemetry observability, a published rate-limiting and API-stability contract, and a coexistence-first inbound Jira pull so a team can adopt without abandoning the tools they already use. Time capture and in-app baselines move up from 0.5 into this release, because a PM cannot pilot a schedule they can't baseline or log time against. And the largest single body of work in the cycle is none of the above: it is the polish, accessibility, and refactoring pass described at the end of this section — the difference between a demo and a beta.

#### How the 0.4 line is numbered

0.4 is the first beta, and it arrives as one — the first tag on the line **is**
the beta. There is no `0.4.0-alpha.N` step:

| Tag | What it means |
|---|---|
| `v0.4.0-beta.1` … `beta.N` | **The first beta.** Feature-complete for 0.4, in production-shaped hardening. |
| `v0.4.0-rc.N` | Optional, if a release candidate is cut. |
| `v0.4.0` | — |

`trueppm-scheduler` publishes a companion tag per artifact in PEP 440 normalized
form — `scheduler-v0.4.0b1` — following the `scheduler-v0.3.0a1`…`a3` history.

Hardening lands under further `beta.N` tags rather than ahead of the first one.
Leaving beta is a **quality judgment, not a date**, so the number of beta tags is
deliberately open-ended, and "0.4, the first beta" throughout these docs names the
milestone rather than any single tag.

One spelling to avoid on the way to a candidate: `0.4.0-beta-rc.1` — a
plausible-looking "candidate for the beta" — is **invalid under PEP 440**, so it
would fail the PyPI publish outright; and under SemVer 2.0.0 it sorts *after*
`0.4.0-beta.1`, inverting the intended meaning, because the `rc` rung of the
alpha → beta → rc ladder sits after beta by construction. Go `beta.N` → `rc.N`.

:::tip[SSO is not an enterprise feature]
Basic single sign-on ships in the **OSS core** at 0.4. The carve-out line is one sentence:
**log in via your own IdP → OSS; provision, deprovision, and govern accounts from a directory →
Enterprise.** Point TruePPM at Keycloak, Authentik, Zitadel, Okta, Auth0, Microsoft Entra ID,
Google, GitLab, or GitHub with a built-in preset — or at any other standards-compliant OIDC
provider (Authelia, for example) via Generic OIDC — and your whole team logs in through it — no
plugin, no paid tier. The enterprise edition earns its price on identity *governance* (SAML 2.0,
SCIM, LDAP/AD directory sync, enforced org-wide SSO), not on the login screen. See [SSO Is Not an Enterprise Feature](/overview/sso-is-not-enterprise/) for
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

- **Read-only MCP server** *(headliner)* (#503 #504 #603) — point any MCP client (Claude Desktop and the like) at your self-hosted instance and ask real questions of the live schedule: critical path, a non-mutating Monte Carlo what-if ("slip this task three days — when do we ship?") with feasibility surfaced over the MCP tool (#1663), sprint status and velocity, the risk register, and My Work. Every answer is computed server-side by the same CPM/Monte Carlo engine the UI uses — never an LLM guess, never leaving your box. This is the principle we call [**computed, not guessed**](/architecture/overview/#computed-not-guessed), and it is the spine of everything AI-facing on this roadmap. A token carries a read-only `mcp:read` scope and must be a **personal** token — project- and program-scoped tokens are rejected on the MCP surface, so a token cannot read more than the person who minted it (#1712). What a given answer may include is then governed by the existing signal-audience ladder, which is what keeps sprint internals private. Read-only by design; agent plan mode (`dry_run` proposals — verdict + impact, nothing commits) follows at 0.5, and committing write tools are deliberately held to 0.6. The server's registry manifest is complete and submission to the MCP registries and client directories is a launch-day step (#1485, tracked on #2271), so TruePPM becomes discoverable from the agent ecosystem, not just from PPM searches
- **Core-flow delight** (#1666) — repair the primary schedule editing loop so the beta feels finished: a working drag-to-link affordance between tasks and Enter-to-add-row on the schedule, the two interactions an evaluator hits in the first minute
- **Basic single sign-on (OIDC / OAuth2)** — point TruePPM at your own identity provider and your whole team logs in through it. Nine built-in presets (Keycloak, Authentik, Zitadel, Okta, Auth0, Microsoft Entra ID, Google, GitLab, GitHub) plus Generic OIDC for any other standards-compliant provider, such as Authelia. Self-hosted, login-only, no directory required — the federation a self-hoster expects as table stakes, not behind a paywall. The org identity-*governance* layer (SAML 2.0, SCIM provisioning, LDAP/AD directory sync, enforced org-wide SSO) stays in the enterprise edition. [**SSO is not an enterprise feature**](/overview/sso-is-not-enterprise/) — the positioning page makes that line explicit and compares it against the open-core competition (#1483)
- **OpenTelemetry observability** (#707–#710) — opt-in OTLP export for traces and metrics across Django, Celery, Channels, the DB layer, and the scheduler engine. Telemetry leaves the box over OTLP only; Prometheus-native stacks scrape it through an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) prometheus exporter, not a first-party `/metrics` endpoint — one deliberate, opt-in egress with no always-on scrape surface. Plug TruePPM into your existing Grafana/Jaeger/Tempo stack with no custom exporter work
- **API rate limiting &amp; stability contract** (#1080) — published per-endpoint rate limits with standard `Retry-After` headers, a documented deprecation policy, and a stability tier so integrators know what they can rely on across releases
- **Client-ready PDF** (#1436 #1437) — a basic Gantt-with-critical-path schedule export from day one (the rich reporting suite lands at 0.8)
- **Read-only share links** (#1486) — a tokenized, expiring, revocable public link to a schedule or board view: the PDF is for the meeting, the live link is for the follow-up. Read-only projection, rate-limited, with a workspace-level switch to disable public sharing entirely. This is how a self-hosted schedule travels beyond its own instance; the 0.6 shareable roadmap builds on the same token mechanism
- **Try before you install** (#1487) — a hosted read-only demo instance with the sample projects (and the bridge wow) preloaded, plus a one-command trial path leading the getting-started docs. The evaluation story starts here, not at the Helm chart
- **Inbound Jira, coexistence-first** (#1418 #1419 #1420 #1421 #1422 — the web + API slice of umbrella epic #1394, which stays open until its mobile connect leg, #1423, lands at 1.0) — a one-way, personal, read-only Jira → TruePPM card pull into My Work, **on demand by default, continuous if you opt in**: connect your own Jira account (Cloud or Data Center / Server) once, and each pull brings your assigned issues in beside your native tasks so contributors never double-enter. A **Check for new items automatically** switch on the connected card (#3104) turns that on-demand pull into a continuous one — off by default, per connection and per person, checking the source roughly every 15 minutes and pausing itself on a connection that needs reconnecting. Run TruePPM alongside Jira and get the CPM forecast without asking the team to switch first (distinct from the full one-time migration import, which lands at 0.6). Paired with a minimal computable Jira import (#1664) — an offline **Export → XML** upload from Jira Server / Data Center, one import per file and no live connection, that turns issues into a CPM-schedulable network — and a write-parity + cycle guard (#1665) that validates any agent- or importer-generated task graph before it touches the schedule
- **Offline hardening** — WebSocket event replay/resync, sync conflict detection, calm offline states
- **Time capture and the weekly timesheet** *(pulled forward from 0.5)* (#1415) — a live running timer on any task, inline quick-log from My Work, and a keyboard-fast weekly cross-project timesheet grid with a submit-week marker. All of it is already in `main`. This is the *capture* half of the actuals story and it lands with the beta because a PM evaluating TruePPM on their own infrastructure needs actuals from day one; manager approval, non-project time categories (PTO, admin, training), and the earned-value feed remain a separate, later track at 0.5 (#100), and EV-lite itself at 0.8
- **Baselines you can capture in the app** *(pulled forward from 0.5)* (#1864) — in-app baseline capture and management on the Schedule, a baseline-vs-current comparison as a table in the task drawer, plus activity rows that name what actually moved when a baseline drifts. The `Baseline` model has been in the product since 0.1; 0.4 is where capturing and managing one stops requiring the API. The planned-vs-baseline **ghost-bar overlay on the Gantt is deliberately out of 0.4** and lands at 0.5 ([ADR-0376](/architecture/decisions/)), as do structured rebaseline reasons and change control (#101)
- **Settings and administration depth** (#2266 #2319 #2320 #2115 #2109 #2021) — help text with a docs link on every setting across Workspace, Program, and Project; a filter box on the settings rail with individual sections indexed into ⌘K; guided Email/SMTP provider setup; a live telemetry-export health card so an operator can see whether OTLP is actually flowing; and an instance-wide MCP kill switch. A self-hoster administers TruePPM from the UI, not from a settings file
- **Findability off-project** (#1557 #1940 #2102 #2103) — the ⌘K palette grows cross-program global search, recent items, and People; an in-chrome project switcher works from anywhere; the programs directory gets search and sort. Global search no longer silently truncates at the first API page
- **Phases as first-class schedule rows** (#1753 #1754 #1755) — an explicit `is_phase` field with a first-class "Add Phase" action, rollup hardening that blocks a direct status, estimate, assignee, or time log on a phase row, and phase-in-a-sprint promoted from a warning to a hard block
- **External-stakeholder registry** (#1658) — a program-scoped list of non-member people (client contacts, email-only) a PM can fold into program-stakeholder pings, extending the `@program-stakeholders` auto-group so it reaches external stakeholders as well as Viewer-role members. The two are resolved **additively but kept separate**, never unioned ([ADR-0264](/architecture/decisions/) §2): an external stakeholder has no user account, so they receive email only and never produce an in-app notification row — which is also what stops internal thread content leaking to a client contact
- **Board viewability overhaul** (#1457) — fixed-width, horizontally-scrollable board columns replace the shrink-to-fit grid, with a sticky two-tier column-header/phase-lane grid, column collapse-to-stub, phase-lane focus mode, and a consolidated worst-offender card badge, so the board a team lives on all day is easy to scan and orient on real projects, not just small demo ones
- **Security hardening** (#1717 #2246 #2247 #2248) — per-account login lockout layered over the IP-only throttle (which a distributed credential-stuffing attempt walks straight past), a dedicated JWT signing key separate from `SECRET_KEY` with a global session-invalidation lever, a genuine session-only sign-in behind "Remember me", and explicit auth-cookie `SameSite`/`HttpOnly` pinning
- **Operator on-ramp pack** (#2217) — a tested backup and restore runbook, a Helm values reference with sizing guidance, and per-release upgrade notes. The chart shipped at 0.1; this is the documentation that makes running it in anger reasonable
- **CSV / Excel import** *(pulled forward from 0.5)* (#111 → #743 #746) — a three-step wizard (upload → map columns → confirm) with fuzzy header auto-detection, WBS indent detection, and row-level errors that never block the rows that parsed cleanly. Most plans that could be running on a CPM engine are sitting in a spreadsheet, and an evaluator who cannot get their own data in never reaches the part of TruePPM worth evaluating. MS Project XML has been an import path since 0.1; this is the one the other 90% need. The one-time Jira migration import (#627) lands at 0.6, alongside the top-10-tool breadth
- **A tested scale envelope** (#2391) — a published statement of what this software has actually been measured to hold: tasks per project, dependency edges, concurrent users and WebSocket connections, Monte Carlo iterations at the task ceiling. Measured off-CI on documented hardware, with each ceiling naming the constraint that sets it, and with what is *untested* stated rather than implied. A beta that invites you to put a real program on your own hardware owes you a number
- **In-product feedback** (#2392) — a report-a-bug entry in the user menu and in ⌘K that opens the tracker with the version, edition, build SHA, and route already filled in. It is a **link, not a beacon**: nothing is transmitted by rendering it, the context travels in a URL you can read and edit first, and an operator can repoint it at their own tracker or remove it entirely. A beta with no path from "this is broken" to an issue we can read produces silence and misreads it as success
- **Provenance and the audit foundation** (#1058, #1805) — the *cite* and *reproduce* halves of the AI contract, both landing with this beta and already merged to `main`. **Provenance** (#1058) gives every computed date, float, and P80 the server-side derivation an agent cites, so an answer is explainable, not asserted. The **agent-action audit foundation** (#1805, [ADR-0112](/architecture/decisions/) Accepted) records every agent read and every verdict — actor, decision, engine version — in a hash-chained, `audit_verify`-checkable log, with an `identity`/`policy` refusal taxonomy from day one; it makes *computed, not guessed* reproducible rather than merely claimed. An **agent-oversight panel** in the admin UI (#2020) surfaces that record to humans — what agents did, what was refused, and why — so oversight is something a team can see, not just something that was recorded. The rest of the AI-native foundation — a local natural-language query layer (#1060) and a bring-your-own local-model adapter (#1061) — moves to 0.6, after the decision &amp; forecast memory it reasons over lands at 0.5, keeping the beta focused on its MCP and evaluation headliners

#### Beta hardening — the unglamorous majority of 0.4

The feature list above is the smaller half of this release. By volume the 0.4 cycle is a
polish, accessibility, and refactoring pass: roughly **900 issues closed** across about
**2,400 commits** since the 0.3 tag, of which fixes, a11y work, refactoring, tests, and
tooling substantially outnumber new surface — around 270 `feat:` commits against roughly
1,050 across `fix`, `test`, `refactor`, `docs`, `chore`, `ci`, and `perf`. That is deliberate. 0.4 is the first release
we ask anyone to run a real project on, and a beta earns that by being *finished*, not by
being *large*. Six standing audits — UX, accessibility, voice-of-customer, red-team,
settings, and security — fed the queue rather than a feature backlog.

0.4 is also the first release to publish a **[tested scale envelope](/administration/sizing/#tested-envelope)** (#2391): measured
capacity per dimension, the issue that sets each ceiling, and an explicit list of what
was *not* tested. A beta that invites people to put a real program on their own hardware
owes them a number rather than silence — including the number that is currently
unflattering. In 0.4 a project stays comfortable in the Schedule view to roughly
**1,000 tasks**, bounded by the whole-project client load. Raising that ceiling is
scheduled work, not a known-unknown: it is tracked on #2277, in the **0.5** milestone.

- **Accessibility remediation** (#1685 #2202 are the axe-gate infrastructure issues; the
  remediation itself ran across the release) — focus traps across roughly seventy dialogs,
  drawers, and popovers,
  44px touch targets on the board and schedule surfaces, contrast fixes in both light and
  dark themes, live-region announcements for route changes and async writes, and keyboard
  operability on the Gantt, board, and outline. Crucially, **axe assertions now run inside
  the Playwright job** across an expanded set of routes and in dark and mobile variants, so
  the pass ratchets instead of decaying. The formal end-to-end WCAG 2.1 AA audit is still a
  0.9 GA-hardening item; this is the remediation that makes that audit survivable
- **Refactoring and complexity reduction** (#2081) — a sustained program against the
  worst-offender functions in both the API and the web app, driven by SonarCloud cognitive
  complexity and CodeQL maintainability findings. No behavior change, and every batch ships
  with its tests: the point is that the 0.5–1.0 feature work lands on a codebase that can
  absorb it
- **Quality gates** — five additions to CI, of two kinds. The difference matters, because
  a job that cannot fail a pipeline is not a gate no matter what it is named.
  **Blocking a merge:** a Helm chart deploy smoke test on a real `kind` cluster (#2279),
  which runs on any change to the chart or to CI and has already caught a real deploy
  regression (the web nginx upstream mismatch, #2283); an OIDC handshake against a live
  Keycloak (#2274) on any change to the SSO app; and deployable images built from the
  commit under test (#2284), so the Helm drill runs HEAD's chart against HEAD's code
  rather than the last released tag. **Reporting nightly, not blocking:** API fuzzing
  against the live OpenAPI schema (#2121) and mutation testing on the scheduler (#2282)
  both run on the nightly schedule with `allow_failure: true`. That is deliberate — a
  fuzz case or a surviving mutant is a triage signal, and letting one red a schedule
  shared with dependency and coverage runs would train everyone to ignore it. Mutation
  testing further reports its score without enforcing a floor, and covers the scheduler's
  models, derivation and CLI rather than the CPM and Monte Carlo core; that scope limit is
  recorded as a [known issue](/overview/known-issues/) and its expansion is tracked on #2468
- **Correctness fixes** — several hundred, concentrated in the surfaces an evaluator touches
  first: the schedule drawer and Gantt interaction model, board and sprint state, the
  settings shell, time capture, exports, and the offline and reconnect paths

## Planned

### 0.5 — plan & people (target: Oct 28 – Nov 11, 2026)

**For the resource manager — and anyone who has to staff a plan, whether the workers are people, or people and AI agents.** The tool warns you'd put someone at 130% *before* you save the assignment, not six weeks later from a burned-out engineer — and the same allocation model takes its first step toward treating an AI agent as a schedulable resource, because for software teams "who does the work" now spans both. Resource allocation and the hybrid human/AI first cut share one engine seam (a worker profile on the resource), so they land together as one story rather than two features. The native Android app moves out of this release to **0.6** — the installable PWA below is 0.5's mobile story — so the milestone concentrates on the staffing charter instead of opening a greenfield native platform alongside it.

0.5 was re-triaged against this charter (#2558). The one-time Jira migration, two-factor authentication, the AI query layer, the agile-team refinement backlog, and the deeper half of the hybrid engine work moved to 0.6; part of the release is deliberately left unallocated for inbound from the 0.4 beta, because the gap that used to sit between releases is now working time. What remains is the staffing charter, the PWA, and MCP plan mode.

- **Installable PWA** *(moved from 0.4)* (#1393) — a full installable progressive web app with an offline-capable shell: add to home screen on iOS or Android, time-entry and board reads work without a signal, and a reconnect banner syncs queued writes when connectivity returns. This is 0.5's mobile story — the native Android app follows in 0.6 — and the 0.4 beta uses the hosted read-only demo as its evaluation story instead
- **Push-notification foundation** (#2132) — service-worker push with a per-user opt-in lands alongside the PWA shell. Its first payload is agent **refusal alerts** — the oversight panel's signal, carried to the phone — and the same plumbing becomes the *approval remote* when the 0.7 change-request queue lands: approve or decline an agent's proposed change from your pocket, projected impact attached
- **First-run onboarding** *(moved from 0.4)* (#725) — a guided setup rail that walks a fresh install from empty dashboard to a running project with real tasks and a schedule: project creation, first task, team invite, and a live-preview mini-board. The full GA-polish pass happens at 0.9; this is the on-ramp that lets a self-hoster be productive in the first session

- **Resource allocation** — partial (e.g. 60/40) assignments per person per project, against a committed-capacity ceiling
- **Pre-commit conflict warning** — over-allocation surfaced before the booking is confirmed, plus a 90-day "what if we hire one more" capacity model
- **Hybrid human/AI scheduling — the shared seam** *(co-headliner)* (#1836) — the first step toward representing AI agents as first-class *resources*, for software teams whose work now runs across people and agents. A worker profile on the resource carries agent throughput, concurrency, and review capacity, extending the resource-allocation model above. This is the engine seam the two headliners share, which is why they land together. The rest of the first cut moves to 0.6, beside the engine depth it belongs with: separating **effort** (work content) from **duration** (elapsed time), so an agent's throughput and round-the-clock availability no longer have to masquerade as an 8-hour human day (#1835), is dual-engine work in both the Python and Rust/WASM engines and is cheaper done alongside sub-day scheduling (#1838) than split across two releases. The **team-owned review-gate read** (#1834) — which surfaces when a team's own review queue, not authoring, has become the bottleneck — follows with it. That queue signal is a team signal by design: team-owned, opt-in to roll upward, never a management surveillance surface ([team ownership is not surveillance](/overview/team-ownership-not-surveillance/))
- **Timesheet depth** (#100) — the governance half of the actuals story, on top of the capture and weekly-grid surface that ships at 0.4: manager approval, non-project time categories (PTO, admin, training), and the earned-value actuals feed, with actuals captured alongside the allocation they belong to
- **Baseline change control** (#101) — structured rebaseline reasons and a change-control trail over the in-app baseline capture and comparison that ships at 0.4, so a rebaseline records *why* and not just *when*
- **i18n framework decision** (#728, moved up from 0.9) — decide string externalization while the UI surface is still small; the self-hosting community is heavily international, and retrofitting extraction gets more expensive every release. Translations themselves can follow after GA
- **Decision & forecast memory** (#1059) — rebaseline reasons, scope-change decisions, and retro actions become a structured, queryable store, so the team — and any agent reasoning over the plan later — has the *why* behind every change, not just the what (cross-program calibration of that history stays enterprise)
- **MCP plan mode — the agent dry run** *(pulled forward from 0.6)* (#1813) — the safest slice of the agent write path, shipped a release early because it commits nothing: an agent submits a **proposed** change over MCP with `dry_run` and the engine answers with the verdict, the constraints that fired, and the projected schedule impact — new critical path, date deltas, or a feasibility refusal with its derivation. The *refuse* verb reaches the write side with zero mutation risk, gated by the **same rulebook as human writes** (sprint sovereignty, phase locks, graph validation) — no agent side door. Builds on the 0.5 agent service accounts (#1811), **agent-as-audited-actor** identity scoping (#1063 — extends the 0.4 audit foundation with a capability-scoped actor identity ahead of the write path), and the audit foundation already in `main`; the committing write surface, engine-as-referee enforcement, and standing subscriptions complete the path at 0.6
- **Workshop facilitation core** (#1396 #1397) — a shared timer and dot voting on the Live Retro Board, riding the existing realtime channel with no new trust surface; the full collaborative-canvas shell (Excalidraw, guest links) follows at 0.7 (#1281)
- **Deep CPM-aware bridge** (#372) — live finish-date forecast and incremental CPM recompute, reconciling sprint capacity with the schedule
- **Durable execution (ADR-0080)** — default workflow backend, workflow versioning, transactional mobile sync upload
- **System Health operator UI** (#691) — dead-letter requeue/drop write actions over the durable-execution backbone (outbox dispatch, Beat heartbeat, retention purge), building on the read-only overview dashboard and dead-letter inspector that shipped at 0.2; rich outbox metrics and subscriber breakdown follow at 1.0

### 0.6 — open & portable (no date — next after 0.5)

**For the team switching off another tool — and the builder who wants to drive TruePPM from code or an AI agent.** Get your data in, get it out, automate it from anywhere — and put the schedule in your pocket: the native Android app ships here as a co-headliner.

- **Native Android app** *(moved from 0.5 — a hard commitment at this release: the 1.0 iPhone/iPad parity work builds directly on this codebase, so it cannot slip again)* — React Native (bare workflow, not Expo managed — native modules and enterprise app-store-only releases rule out Expo managed per ADR-0026) + WatermelonDB; My Tasks, 15-second time capture, on-device WASM CPM, offline sync, Play Store submission. Android phones first, tablets second; iPhone ships at 1.0. Until it lands, the 0.5 installable PWA is the offline mobile story. **Open charter question** (#2220): as scoped, 0.6 is My Tasks + time capture + on-device CPM — not a schedule/Gantt editor. Sarah's (PM persona) hard NO is "mobile that's read-only — a viewer rather than a real editor," and that criterion is not met by this scope alone; whether offline schedule editing with reconnect-cascade lands within 0.6 or is deliberately deferred to the 1.0 iPhone/iPad window is an open decision, not yet made
- **Multi-format import with preview** (epics #624, #613) — top-10 PM tools (Jira, Asana, Monday, Wrike, ClickUp, Planview, Trello, Notion, Linear, Basecamp). CSV/Excel lands earlier still, with the 0.4 beta — 0.6 adds the breadth and the preview polish, and the specialist long-tail (Primavera P6 XER/PMXML, OmniPlan, GanttProject, MPX/ProjectLibre — #630–#635) follows at 0.7 so this release keeps its focus on Android and the write surface
- **Get your data in — the Jira migration** *(returned from 0.5)* (#627) — a one-time Jira migration import, for the team that has decided to move rather than coexist (the personal read-only Jira pull ships at 0.4). Switching tools is not a persona — it is the funnel stage every persona passes through. It sits here, in the release built around getting data in and out, rather than inside the staffing charter
- **MCP write surface** (#505 #604) — write tools (create/update task, move card, log time, update status), session auth, and broader surface coverage layered on top of the read-only MCP server that lands in 0.4, with read restrictions on sprint-internal fields so automation never becomes surveillance
- **Safe agent writes** — the write path lands **on top of the audit foundation already in `main`** (the *reproduce* substrate from 0.4), so an agent can act without wrecking the plan: an **engine-as-referee** (#1062) that refuses any write which would create an impossible schedule — the committing side of the plan-mode `dry_run` that ships at 0.5 — building on the **agent-as-audited-actor** capability-scoped identity that ships at 0.5 (#1063), and **standing subscriptions** (#1064) so an agent can be told "alert me when P80 crosses the committed date." Two more guarantees ship in the **same release as the write surface — non-negotiable ordering**: **agent write receipts** (#2133), so every committed agent write shows *by agent, on behalf of principal, with verdict and a link to the audit entry* right in the task activity feed and change history — no one should ever wonder whether a robot moved a date, or why — and **containment** (#1815): per-agent suspend, a global "pause all agents" switch, and basic rate ceilings, so the off-switch never trails the capability it controls. Organizational governance of those agents — immutable audit, approval workflows, spend budgets, anomaly auto-suspend — stays in the enterprise edition
- **Instance #2 — the open falsification** (#1998) — the one AI-native item that is *building*, not naming. Everything grounding-related above grounds a single domain: scheduling feasibility. This experiment expresses one concrete **non-scheduling** control — a DORA or data-residency rule — as an `Invariant` and runs it through the *same* verdict → refusal → audit path the scheduling checks use. If it refuses-with-derivation and writes a clean agent-action audit entry with no knowledge of tasks or schedules, the refusal pipeline generalizes and the domain-agnostic `Invariant → Verdict` registry becomes real; if it does not, we have learned the boundary cheaply. **Unproven by design** — the *attempt* is committed, the *outcome* is not: the spike runs time-boxed at the top of 0.6, before the write surface lands, and produces a written result memo either way. If it passes, a domain-agnostic invariant registry follows at 0.7 (#2137); if it fails, we record "scheduling-specific by design" and move on. No public copy describes TruePPM as a general "grounding engine" until it passes
- **Agent-governance starter kit** (#2134) — a docs deliverable shipping the same week as the write surface: a sample agent-use policy, a RACI for agent operations, least-privilege token-scope templates, a staged rollout checklist (agents off by default → read-only Q&A → plan-mode dry runs → approvals → scoped writes), and a one-page data-flow diagram showing nothing leaves the instance boundary. Enablement is always configured as a relaxation, never as a safety setting
- **Public REST API depth** and JSON import/export
- **Read-only shareable roadmap** — a now/next/later + timeline view a PO can hand to a stakeholder, built on the 0.4 share-link token mechanism (#1486)
- **OSS integration connectors** — calendar export, Drive/Box/Dropbox preview, meeting links
- **Jira integration, outbound** (#93) — read-on-demand Jira issue-link previews and one-way TruePPM → Jira status push over the existing webhook infrastructure, so a contributor sees current Jira state without a second account and their status changes flow back to Jira; the bidirectional ingest, reconciliation loop, and Atlassian OAuth flows stay enterprise
- **Ephemeral trial instances** (#1672) — a self-service, on-demand 7- or 30-day sandbox instance that auto-provisions and auto-destroys, the post-beta Tier-3 evaluation story on top of the 0.4 hosted read-only demo (#1487); gated on measured traction from that demo and a hardened trial-mode control set (egress kill switch, no public content hosting, quotas, provisioning friction, audited lifecycle teardown)
- **Hybrid human/AI scheduling — engine depth** (#1837 #1838 #1839 #1840) — the engine work behind the 0.5 first cut. Sub-day scheduling will land in both the Python and WASM engines so a 20-minute agent task no longer rounds to a whole working day (#1838); a `delivery_mode="agent"` task class will carry a probabilistic **fallback-to-human** branch the Monte Carlo samples, so a plan honestly reflects "sometimes a human has to step in" (#1837); the Gantt will render agent work as a queue glyph rather than an invisible sub-hour bar (#1839); and three-register reporting will report human dates, agent effort and throughput, and the program's true unit — the length of the human-bound critical path (#1840). The effort/duration split (#1835) and the team-owned review-gate read (#1834) join this release from 0.5, so the whole dual-engine change lands as one body of work rather than split across two releases. Portfolio-level agent governance — agent-ROI, cross-program leveling, org approval workflows — stays in the enterprise edition, after 1.0
- **AI query layer & local-model adapter** *(moved from 0.5)* (#1060 #1061) — a local natural-language layer that compiles a question into engine calls (never into an answer) and a bring-your-own local-model adapter so the AI runs against a self-hosted model and nothing — plan or inference — leaves your box. The model translates, the engine answers — *computed, not guessed*, applied to natural language. It lands here rather than at 0.5 because it is not a dependency of MCP plan mode; the decision &amp; forecast memory it reasons over ships at 0.5 ahead of it
- **Two-factor authentication (TOTP)** *(moved from 0.5)* (#2216) — authenticator-app codes (Google Authenticator, Authy, 1Password, or any RFC 6238 app) with single-use recovery codes for local password accounts, plus an admin recovery command and ops runbook. Opt-in per user; SSO logins keep delegating MFA to your IdP — no double challenge. Org-wide MFA *enforcement* (per-role mandates, disabling local-account fallback) stays in the enterprise edition — the same mechanism-vs-governance line as SSO itself
- **Agile-team refinements (continued from 0.3)** *(moved from 0.5)* — sprint, board, and hybrid-bridge polish that keeps maturing the Scrum-Master and Product-Owner surfaces. 0.5 was the holding line for this work; re-triaged against the staffing charter, it lands here. Not all of it is committed to 0.6

### Direction — beyond 0.6

Everything below is **committed in intent, uncommitted in position**. It is on this page
because we intend to build it, not because we know when. Where a version number appears it
records how the work is currently sequenced in the tracker — a **sequence, not a schedule** —
and we expect the 0.4 beta to reorder it. The full backlog lives as open issues in
[GitLab](https://gitlab.com/trueppm/trueppm/-/issues).

**The product owner's surface** *(currently 0.7)* — an editable now/next/later product
roadmap with release-target lanes per epic, release planning across sprints with
velocity-based delivery ranges, and matured backlog ↔ schedule reconciliation, so the PO and
PM never maintain two representations of the same work. With it, the **mindmap view** (#2093):
the live WBS as an editable node tree — a *projection, not a document*, where every node is a
real task or phase row, a drag is a real reparent, and plan mode's verdict machinery badges a
dragged branch with its real schedule impact *before* the drop.

**The platform opens up** *(currently 0.7, graduating at 0.9)* — the *internal* slot registry
the enterprise edition already registers against is formalized (#2094) and dogfooded by two
deliberately different surfaces: the mindmap, and the **collaborative canvas shell** (#1281) —
the Excalidraw-based workshop surface with sticky notes, CRDT co-editing, and anonymous guest
links, riding the shipped workshops substrate. Canvas scenes stay freeform *artifacts*; the
mindmap remains the structured projection, so a whiteboard never becomes a second place the
plan lives. The extension points those dogfoods prove graduate into a public **Extension SDK**
— custom fields, views, widgets, workflow actions, webhook events. Extending your own instance
is OSS; governing extensions across an org (install approval, allow/deny policy, signed-plugin
provenance) is enterprise.

**The trust gradient for agents** *(currently 0.7)* — **Change Requests** (#1312) route agent
plan-mode proposals to a **named approver** who sees the projected schedule impact and records
a disposition on the audit chain: *change request, impact analysis, disposition*, the
vocabulary every PMO already uses, applied to agent proposals. **Shadow (advisor) mode**
(#2135) is the rung below — agents propose silently against the dry-run path and nothing
surfaces but a weekly digest of what they would have suggested and what the engine would have
refused, the on-ramp for teams not ready for interactive agents. A single approver is OSS;
multi-step chains, delegated authority, and org-wide policy stay enterprise.

**Memory a forecast can cite** *(currently 0.7)* — the **assumption & constraint log** (#2136)
grows decision memory (#1059) first-class assumptions and constraints, so a derivation can say
"P80 is Oct 22, *assuming vendor delivery by the 3rd*" — and invalidating an assumption flags
every forecast that cited it. The **invariant registry** (#2137) is gated on the #1998
falsification result: if it passes, the shipped scheduling checks (graph validation, sprint
sovereignty, phase locks) lift behind a domain-agnostic `Invariant → Verdict` registry with
behavior-identical conformance tests; if it fails, the issue closes as "scheduling-specific by
design" and the capacity returns to product-owner depth.

**Importer long-tail** *(currently 0.7)* (#630–#635) — the specialist formats: Primavera P6
XER/PMXML, OmniPlan, GanttProject, and MPX/ProjectLibre. Held out of 0.6 so that release stays
focused on Android and the write surface.

**Reporting stakeholders live on** *(currently 0.8)* — the headliner is **auto-narrative: "why
did the date move"**. Every status meeting exists to answer that question, and TruePPM answers
it from the engine: the actual chain of changes behind a date move, computed from the
provenance graph (#1058) rather than reconstructed from memory. An **agents section** (#2138)
extends it to what agents did this period and what was refused, computed the same way from the
audit chain (#1805). Beside it, **EV-lite** (#2139) — PV/EV/AC with SPI/CPI, pure deterministic
formulas over baselines, timesheet actuals, and the cost data landing with it — plus Gantt PDF,
print/share, what-if scenarios, baseline variance, resource costs and cost reports, custom
5/7-day work weeks, and a configurable fiscal year. The **Team Cohesion technical preview**
(#1488) also publishes here, as a post and an experimental flag, so the 1.0 marquee arrives
validated rather than asserted. Single-project narrative is OSS; cross-program schedule
forensics stays enterprise.

**The program as one view** *(currently 0.8)* — one timeline across a program's projects,
cross-project dependency lines, program rollup, single-program resource leveling, and risk-slip
propagation, plus an opt-in read-only RAG health digest at the program level. This is also
where the five `program_*` WebSocket events become deliverable (#836). Cross-*program*
portfolio rollups stay enterprise.

**GA hardening** *(currently 0.9)* — public API v1 freeze, the formal WCAG 2.1 AA audit,
performance and scale validation, and i18n/l10n execution against the framework decision made
at 0.5 (#728), alongside an onboarding and intuitiveness pass that audits the "easier than MS
Project / Planview / Smartsheet" promise end to end. The *reproduce* verb completes here:
**reproducible answers** (#1065) stamp a computed response with an engine version and input
hash so an AI-surfaced number can be re-run and audited later; **audit & evidence export**
(#2140) puts the agent-action chain, answer stamps, and an `audit_verify` attestation inside
API v1; and the **status snapshot archive** (#2141) seals a monthly point-in-time status pack
— what we reported, and provably what we knew when we reported it. OSS ships complete,
verifiable evidence data anyone can check; regulator-shaped packaging (DORA / SR 11-7 /
AI-Act bundles, retention, legal hold) stays enterprise, building against that seam.

**1.0 — first stable release** — the marquee differentiator is **Team Cohesion** (epic #582):
a Brooks'-Law friction coefficient that feeds Monte Carlo, making TruePPM the first PPM tool to
model team friction as a first-class scheduling input. Mobile completes here with **iPhone and
iPad parity** — App Store submission, TestFlight, and iOS-side Detox parity on top of the
Android codebase shipped in 0.6 — beside workflow-engine maturity (ADR-0080: dead-letter,
history API, idempotency hardening, observability, a second DBOS backend) and a pre-1.0
sample-project refresh. The AI-native arc threaded across this roadmap — the read-only MCP
server, provenance, and the agent-action audit foundation (0.4), the write surface with
engine-as-referee and standing subscriptions (0.6), and the trust-gradient stages above —
completes here under GitLab's umbrella epic **human + agent coexistence substrate** (#1315,
labeled `killer-feature`): a team running agents safely against one deterministic
plan-of-record they plan against, act on, and answer to. Org-scale governance of that same
substrate — immutable cross-team audit, mandatory approval policy, capability roles,
model/data-egress governance — is the enterprise overlay.

**Unsequenced** — intended, but not placed against any release. **Methodology Packs**
(epic #577) — versioned phase bundles that slot into existing projects, with mechanical
validation (cycle detection, milestone reachability, role coverage) and a local pack registry
(file / git / http sources). Deeper earned-value surfaces on the Schedule view (EV-lite itself
is above), cycle-time and throughput analytics on the board, and sub-tasks and checklists on
stories sit here too. **Methodology Marketplace** and **Automated Cohesion Inference** are
enterprise-edition extensions built on the pack format and the Team Cohesion model
respectively. When one of these becomes the next thing we are actually building, it moves up
into a numbered release.

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
- Methodology Marketplace and Automated Cohesion Inference (both undated — see **Direction** above)
- **AI governance overlay** — the organizational counterpart to the OSS AI layer, registering against its extension points: immutable agent audit trail, approval workflows for agent writes, custom agent roles and capability policy, cross-program AI decision-memory and forecast calibration, portfolio AI scenario modeling, org-wide AI model-governance and data-egress policy, compliance evidence export for AI-assisted decisions, and bidirectional Integration-Hub AI-reconciliation
