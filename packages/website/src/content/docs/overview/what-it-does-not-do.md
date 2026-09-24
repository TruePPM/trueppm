---
title: What TruePPM Doesn't Do Yet
description: The maintained list of capability gaps — resource leveling, constraint types, cost and earned value, scale ceilings, and mobile. Read this before you evaluate, not after.
documentedFor: "0.4"
---

Most project-management sites tell you what a tool does. This page tells you what
TruePPM **does not** do, so you can disqualify it in five minutes instead of forty.

It is a maintained page, not a disclaimer. Every gap below names the issue tracking
it and the release it is planned for, or says plainly that it is not planned. When a
gap closes, the row moves to the [roadmap](/overview/roadmap/) as shipped and comes
off this page.

This page states the constraints. For the corollary — who these constraints mean
TruePPM fits today, and who it does not — see
[Who this fits today](/overview/#who-this-fits-today) in the Platform Overview.

This page covers capability that was never built. For things that *are* built but are
wrong, incomplete, or slower than they should be, see
[Known Issues](/overview/known-issues/).

:::caution[Read the version status first]
TruePPM is pre-GA. The current shipped release is the first beta, 0.4 (currently
`v0.4.0-beta.4`). Anything below marked for 0.5 or later is planned, not built. The
[roadmap](/overview/roadmap/) is the authoritative Shipped / Underway / Planned
record.
:::

## Scheduling gaps

These are the ones that matter most, because scheduling is what TruePPM claims to be
best at.

### Resource leveling — not implemented

The engine computes the schedule. It will **not** resolve an over-allocation for you.
There is no leveling pass: if you assign one person to three concurrent critical
tasks, TruePPM will compute dates that assume they can do all three at once.

- **Today:** nothing. The engine's public surface is `schedule()` and `monte_carlo()`.
- **0.5:** per-project partial allocation (e.g. 60/40) with over-allocation *warnings*
  surfaced before the booking is confirmed — a warning, still not a leveling pass.
- **0.6:** a leveling pass in the OSS core
  ([#1442](https://gitlab.com/trueppm/trueppm/-/issues/1442)) — a resource-constrained
  pass over the CPM result that shifts activities within their float, then beyond it,
  until no resource is loaded past capacity, within a single project or program. 0.6
  carries no date: this is a sequence, not a schedule.
- **After 1.0, enterprise edition:** cross-*program* resource leveling.

**If you need automatic resource leveling today, use Primavera P6 or MS Project.**
This is the single largest functional gap between TruePPM and the traditional
scheduling tools, and we would rather say so than have you discover it mid-pilot.

### Schedule constraints — one type, not eight

TruePPM honors `planned_start` as a **start-no-earlier-than** constraint. That is the
only constraint type the engine implements.

There is no must-start-on, must-finish-on, finish-no-earlier-than,
finish-no-later-than, as-late-as-possible, or deadline constraint. `planned_finish`
exists on the model but the backward pass does not yet treat it as a
finish-no-later-than constraint — it is reserved, and honoring it is a separately
reviewed change.

MS Project ships eight constraint types plus deadlines. If your schedules are
contractual and lean on must-finish-on dates, TruePPM cannot express them yet.

The intended direction is recorded in [ADR-1049](/architecture/decisions/), **proposed
and not yet accepted**: honor `SNET`, `FNLT`, `MSO`, and `MFO`, keep the deadline as a
separate soft marker with negative float against it (0.5), and omit `ALAP`, `SNLT`, and
`FNET` with a documented workaround for each. The constraint set itself is sequenced for
0.6. Until then this section stands as written.

### Effort-driven scheduling — the engine is duration-only

A task has a duration. It does not have effort. Assigning a second person to a
ten-day task leaves it a ten-day task; there is no fixed-work, fixed-units, or
fixed-duration task type, and no way to say "this is forty hours of work, however many
people do it". MS Project and P6 both schedule from effort and units when asked to.

The split of effort from duration is tracked as
[#1835](https://gitlab.com/trueppm/trueppm/-/issues/1835), sequenced for 0.6. It has
been described elsewhere as part of the hybrid human/AI scheduling work, and it does
serve that; but it is a core scheduling gap for a PM staffing a plan with people, and
it is listed here as one.

### Sub-day scheduling — whole days only

Durations are whole working days. A twenty-minute task rounds to a day. Sub-day
scheduling is planned for 0.6, in both the Python and WASM engines, as part of the
hybrid human/AI scheduling work.

### Critical Chain (CCPM) — not in the OSS core

Buffer management and critical-chain scheduling are planned for the enterprise
edition after 1.0. The OSS core is CPM plus Monte Carlo.

## Cost and earned value — not present

There is no cost model. No resource rates, no budgets, no actual-cost tracking, no
earned value.

- **0.5:** timesheet depth — manager approval, non-project time categories, and the
  earned-value actuals feed.
- **0.8:** resource costs, cost reports, and EV-lite (PV/EV/AC with SPI/CPI) computed
  from baselines and timesheet actuals.

**If your practice is cost-centric — if the first question your PMO asks is "what's
the CPI?" — TruePPM is not ready for you.** Planview, Clarity, and P6 are built
around this and TruePPM is not, yet.

## Status and variance reporting — not present

A project carries a four-value health flag (`ON_TRACK` / `AT_RISK` / `CRITICAL` /
`AUTO`) and nothing else a stakeholder can read. There is no status report, no narrative
behind the flag, no "what moved since the baseline" view, and no one-page export a
sponsor could receive. The Reports tab holds burn charts and a decisions log. Every input to a status report
— milestones with baseline variance, critical path movement, P50 / P80, risk severity,
completed and slipped counts, decisions — is computed and stored; nothing assembles it.

- **0.5:** the **project status update** —
  [#3425](https://gitlab.com/trueppm/trueppm/-/issues/3425) — a PM-chosen RAG, a
  written narrative, and a computed snapshot of those facts captured at post time,
  with history on the project Overview, a per-project rollup on the program Overview,
  a one-page PDF, and a read-only share render.
- **0.8:** a generated draft of the narrative from the same snapshot
  ([#370](https://gitlab.com/trueppm/trueppm/-/issues/370)) — the report written for
  you, edited before it goes out.
- **Enterprise:** a report builder, scheduled delivery to arbitrary audiences, and
  cross-program status packs ([ADR-1048](/architecture/decisions/), proposed).

**If the weekly status report is the artifact your PMO runs on, TruePPM cannot produce
it today.** It is the largest gap on this page that is not an engine gap, and it is the
reason 0.5 carries it as a headliner.

## Change control — a rebaseline reason is coming; a scope-change log is not here

A baseline has a name and a frozen calendar. It does not record *why* it was taken,
what changed since the previous one, or who agreed to the change. Baseline change
control — a required reason and a visible changeset when you rebaseline — is
[#101](https://gitlab.com/trueppm/trueppm/-/issues/101) (0.5) and
[#3150](https://gitlab.com/trueppm/trueppm/-/issues/3150) (a 0.4 stretch item, not promised for the beta).

A **change request** — a proposed scope or schedule change with an impact analysis and
a recorded disposition — does not exist for a human proposer.
[#1312](https://gitlab.com/trueppm/trueppm/-/issues/1312) (0.6) delivers a single-approver
change request that a PM or an agent can raise. Multi-approver change-control boards
and org-mandated approval are Enterprise; the line is
[ADR-1048](/architecture/decisions/), proposed: the PM's own record, including one
approver they chose, is OSS; a mandated second-party sign-off is Enterprise.

## RAID — one letter of four

Risks and decisions ship. The rest of the standard RAID set does not:

- **Issues register** — [#2318](https://gitlab.com/trueppm/trueppm/-/issues/2318),
  0.6 (a program-scoped register; cross-program transfer may follow later).
- **Assumption and constraint log** —
  [#2136](https://gitlab.com/trueppm/trueppm/-/issues/2136), sequenced for 0.7.
- **Action items** exist only as retrospective actions on the agile side.
- **Stakeholder register** — [#3427](https://gitlab.com/trueppm/trueppm/-/issues/3427),
  filed as direction with no milestone.

The risk register itself does not yet affect the forecast; see
[Known issues](/overview/known-issues/).

## Workflow — six fixed task statuses

`Task.status` is a fixed set: Backlog, Not started, In progress, Review, Complete, and
a legacy On hold. Board columns can be renamed, reordered, hidden, colored, WIP-capped,
and split into lanes — but a status cannot be added, and there are no transition rules.
A team whose workflow is `Triage → Spec → Build → QA → UAT → Done` cannot express it,
and imports from Taiga or OpenProject collapse their statuses onto the fixed six.
OpenProject Community and Taiga both ship per-project statuses for free.

The intended direction is [ADR-1050](/architecture/decisions/), **proposed and not yet
accepted**: per-project workflow states layered over the fixed set as a canonical, so
the team's vocabulary becomes a fact about the task while every subsystem keeps
reasoning against the same six values. Statuses are sequenced for 0.6, transition
rules for 0.7. Until then, lanes are the workaround for the board and there is none for
filtering or the API.

## Scale — a measured ceiling, and an unflattering one

A project stays comfortable in the Schedule view to roughly **2,000 tasks** — about
**1,000** on 0.4.0-beta.1, where PostgreSQL's JIT compiler spends seconds compiling every
page of the task list (#3829). The database is not the constraint: it holds 100,000 tasks
in 208 MB and serves the first page of them in 127 ms. The constraint is that opening a
project makes the Schedule read *every* page, each page skips the rows before it, and
skipping a row still costs its per-task subqueries. A 16,000-task project takes about 40
seconds to open; a 100,000-task project would take over half an hour, and would send 229 MB
of JSON to the browser.

Opening the Schedule is not the only wall on the way to 100,000 tasks. The scheduler
refuses a project whose task durations *sum* past 1,000 years, as if every task ran in
series — measured refusing at 64,000 tasks (#3830). Recalculation needs ~30 KB of memory
per task against a 2 GiB worker limit (#3831). Every remote edit re-fetches the whole
project for everyone watching (#2341). And a program with cross-project dependencies
recalculates as one project the size of all its members together. Each is tracked for
0.5, along with a first measurement of the browser at this scale (#3832); the sequence is
on #3383. We are not publishing a target number until that work is measured — this page
published two figures in 2026 that better measurement overturned.

The full per-dimension measurement — tasks per project, dependency edges, concurrent
users and WebSocket connections, Monte Carlo iterations at the task ceiling, the
hardware it was measured on, and an explicit list of what was **not** tested — is
published in the [tested scale envelope](/administration/sizing/#tested-envelope).

For comparison, Primavera P6 routinely carries schedules two orders of magnitude
larger. Large EPC, construction, and defense programs are out of TruePPM's range
today, and we are not going to pretend otherwise.

## Mobile — no released app yet

- **Today:** the web UI is responsive, but there is nothing installable and no
  offline-capable shell you can add to a home screen. A React Native **scaffold**
  exists in the repository: a five-tab navigation shell with placeholder screens,
  plus typed module boundaries for the offline store, the sync client, and
  authentication that are not yet implemented. There are no native Android or iOS
  projects, so it cannot be built or installed — not by us either. CI runs lint and
  type-check on it; there is no test suite. Treat it as a placeholder, not as an
  unreleased app — no native app is scheduled.
- **0.5:** an installable PWA with an offline shell — add to home screen, time entry
  and board reads without a signal. This is the mobile story through 1.0.
- **Native Android and iOS apps:** not on the roadmap. An earlier plan put Android
  at 0.6 and iPhone and iPad at 1.0; that plan was withdrawn on September 16, 2026
  (#3834). A native app returns to a numbered release when people running TruePPM
  report a mobile workflow the PWA cannot serve.

## Integrations — thin, deliberately

MS Project XML round-trips today. Beyond that the surface is narrow:

- **0.4:** CSV / Excel import, a Jira Server / Data Center XML import into an existing
  project, and a personal, read-only, one-way Jira sync into My Work — coexistence, not
  migration.
- **0.6:** a one-time Jira migration import *(returned from 0.5 in the 0.6
  re-triage)*, breadth across the top-10 tools (Asana, Monday, Wrike, ClickUp,
  Trello, Notion, Linear, Basecamp), and full `.mpp` support.
- **0.7:** the specialist long tail — Primavera P6 XER/PMXML, OmniPlan, GanttProject,
  MPX/ProjectLibre.

There is no marketplace, and there will not be one soon. The internal plugin
architecture is planned for 0.7 and a public Extension SDK for 0.9. Redmine's
ecosystem is its main advantage over TruePPM and will stay that way for some time.

## Internationalization — English only, hardcoded

There is no i18n framework wired into the web app — no i18next, react-intl, or
equivalent — and UI strings are hardcoded English throughout. There is no locale
switcher, no translated string catalog, and no RTL support.

- **0.5:** the i18n framework decision itself
  ([#728](https://gitlab.com/trueppm/trueppm/-/issues/728)) — whether to commit to
  string externalization now or defer, made while the UI surface is still small
  because retrofitting extraction gets more expensive every release.
- **0.9:** i18n/l10n execution against whatever framework decision is made in 0.5, as part
  of GA hardening.

A framework decision is not a commitment to any particular translated language.
**If you need TruePPM in a language other than English, there is no workaround today**
beyond running a browser translation extension over the UI.

## AI scheduling / auto-optimization — not present

TruePPM has no AI-driven auto-scheduling, auto-optimization, or AI-generated
sequencing anywhere in the product. Nothing re-sequences a schedule, chooses a
critical path, or performs resource leveling by inference — that is math, computed
by the deterministic CPM/Monte Carlo engine, not a model's opinion. See
[Computed, not guessed](/overview/computed-not-guessed/).

This is worth stating plainly because it is easy to conflate with two things that
are **not** it:

- **The read-only [MCP server](/features/mcp-server/)** answers questions about a
  schedule the engine already computed — critical path, a non-mutating Monte Carlo
  what-if, sprint status. It does not decide anything and it cannot write.
- **Hybrid human/AI scheduling**, planned for 0.5–0.6, represents an AI *agent* as a
  schedulable resource — effort separated from duration, throughput and concurrency
  on a worker profile — so a team whose work spans people and agents gets one plan.
  The schedule is still computed by CPM; nothing about that work has the engine
  deciding a schedule instead of computing one.

"AI scheduling and scenario modeling" appears on the enterprise roadmap with no
committed release. It does not exist in any form today, OSS or enterprise.

## Data residency and multi-region — not present, not currently planned

TruePPM does not support pinning data to a geographic region or replicating it
across regions. A self-hosted instance runs wherever you deploy it — which is
itself a form of jurisdictional control — but there is no in-app region tag, no
data-locality enforcement, and no multi-region active-active deployment topology.
If your organization needs a formal data-residency guarantee or a multi-region
deployment, you have to build it at the infrastructure layer yourself; TruePPM has
no first-class support for it, and it is not currently on the roadmap.

## Account erasure (GDPR-style right to be forgotten) — not present, not currently planned

An administrator can deactivate or delete a user account, but a deleted account
leaves its historical work in place — the tasks, comments, and time entries it
authored resolve their owner to null rather than being erased with the account.
There is no self-service "delete my account and data" flow and no anonymization
routine. If your organization needs a formal right-to-erasure workflow for
compliance, that is a manual, database-level exercise today. It is not currently
on the roadmap.

## Notification channels — email and in-app only

- **Today:** a user's personal notification preferences cover **email** and
  **in-app** only. Separately, project-level outgoing event automation can post to
  a Slack-compatible incoming webhook URL (this also works for Discord and
  Mattermost) — that is a different mechanism from personal notification
  preferences and does not extend them.
- **Push notifications** (browser/PWA and mobile) are not yet built.
  [#2132](https://gitlab.com/trueppm/trueppm/-/issues/2132) tracks the PWA
  push-notification foundation.
- **Slack DM, Teams DM, and SMS** as personal notification channels are registered
  as enterprise extension points ([ADR-0049](/architecture/decisions/)) — not
  planned for the OSS core.

## High availability — partial, and not turnkey

- **The API and Celery worker tiers support multiple replicas today.** An optional
  `PodDisruptionBudget` and `HorizontalPodAutoscaler` shipped in the 0.4 Helm chart,
  both off by default. Celery-originated broadcasts reach WebSocket clients
  connected to any API pod, so horizontal API scaling is safe.
- **Celery beat is single-replica by design**, not a gap — exactly one Beat process
  fires the periodic drains, and running two would double-dispatch every job.
- **The bundled Valkey pod is single-node, with no replication or failover.** For
  real HA you disable it and bring your own: a replicated primary behind one
  stable endpoint (`REDIS_URL`) is the path to rely on today. **Sentinel** is
  configurable via the `TRUEPPM_VALKEY_*` settings but shipped **experimental** in
  0.4 — wired and unit-tested, not yet verified against a live quorum failover.
  **Cluster mode is not supported** — TruePPM uses four logical databases and a
  clustered endpoint exposes only one. See
  [Valkey HA](/administration/valkey-ha/).
- **Postgres HA is not part of the chart today.** You bring your own HA database,
  the same as you would with most self-hosted software. An operator-managed
  in-cluster HA PostgreSQL mode with automatic failover and WAL archiving
  ([#3403](https://gitlab.com/trueppm/trueppm/-/issues/3403)) and a replicated
  in-cluster Valkey ([#3404](https://gitlab.com/trueppm/trueppm/-/issues/3404))
  are planned for 0.5, under the
  [cloud-native epic](https://gitlab.com/trueppm/trueppm/-/issues/3408).
- **Where the OSS line sits.** Basic, single-cluster HA — surviving a pod or node
  loss — is in the OSS core so self-hosters are not penalized for running their
  own datastores. Advanced HA and disaster recovery — cross-region replication,
  geo failover, active-active with leader-elected singletons, SLA-grade failover
  evidence — is Enterprise.

**If "no single point of failure" out of the box is a requirement, TruePPM is not
there yet** — every tier can be made HA, but you assemble it yourself. See
[Deployment](/administration/deployment/) and [Valkey
HA](/administration/valkey-ha/) for the how.

## Governance and portfolio — out of the OSS core by design

Not a gap so much as a boundary, but evaluators should know where it falls. The
following are enterprise-edition features and are **not** coming to the OSS core:
portfolio dashboards and health scores across many programs, demand intake, custom
roles, approval workflow chains, immutable audit trail, multi-tenancy, SAML/SCIM/LDAP
identity governance, cross-region HA and disaster recovery, and cross-program
resource leveling.

One more thing an evaluator of the portfolio tier should know: **the enterprise edition
is not built yet.** As of September 2026 its repository holds a scaffold and no product
code. "Enterprise" on this page and on the roadmap names where a capability *will* live,
not something you can buy today.

What *is* in the OSS core: everything one project manager, program manager, or team
needs to run their own program — including
[basic SSO](/overview/sso-is-not-enterprise/), program rollup, and the full
scheduling engine. The line is
[adoption versus governance](/overview/principles/), and we state it explicitly
rather than leaving you to discover it at a pricing page.

## Maturity — the honest framing

TruePPM's first OSS release was May 2026, and it is built part-time. 0.4 is the
current line and the first beta — the release line left alpha behind at 0.4.
OpenProject has roughly fifteen years, a company behind it, full-time staff, and a
support contract you can buy. Redmine has twenty.

What we offer against that: a public
[commit history](https://gitlab.com/trueppm/trueppm/-/commits/main), a
[roadmap](/overview/roadmap/) that publishes its target dates at honest precision and
a cadence we believe we can hold, a tested scale envelope, and this page. Those are
the evidence available to a young project. Whether they are enough is a reasonable
thing to decide against us.

**If you're running real teams, wait for the release line to reach `rc` or stable** —
we're still learning what needs to change from early feedback. That is our own
recommendation, and it is in the README too.

## Found something missing from this page?

That is a bug in the page, and we would like to fix it.
[Open an issue](https://gitlab.com/trueppm/trueppm/-/issues) — including if a claim on
[How TruePPM compares](/overview/how-it-compares/) is out of date or wrong about
another tool.
