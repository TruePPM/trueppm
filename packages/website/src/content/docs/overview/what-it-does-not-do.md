---
title: What TruePPM Doesn't Do Yet
description: The maintained list of capability gaps — resource leveling, constraint types, cost and earned value, scale ceilings, and mobile. Read this before you evaluate, not after.
---

Most project-management sites tell you what a tool does. This page tells you what
TruePPM **does not** do, so you can disqualify it in five minutes instead of forty.

It is a maintained page, not a disclaimer. Every gap below names the issue tracking
it and the release it is planned for, or says plainly that it is not planned. When a
gap closes, the row moves to the [roadmap](/overview/roadmap/) as shipped and comes
off this page.

This page covers capability that was never built. For things that *are* built but are
wrong, incomplete, or slower than they should be, see
[Known Issues](/overview/known-issues/).

:::caution[Read the version status first]
TruePPM is pre-GA. The current shipped release is an alpha, and the first beta is
0.4. Anything below marked for 0.5 or later is planned, not built. The
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
- **After 1.0, enterprise edition:** cross-program resource leveling.

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

## Scale — a measured ceiling, and an unflattering one

A project stays comfortable in the Schedule view to roughly **1,000 tasks**, bounded
by the whole-project client load rather than by the engine. The engine itself handles
considerably more; the browser is the constraint.

The full per-dimension measurement — tasks per project, dependency edges, concurrent
users and WebSocket connections, Monte Carlo iterations at the task ceiling, the
hardware it was measured on, and an explicit list of what was **not** tested — is
published in the [tested scale envelope](/administration/sizing/#tested-envelope).

For comparison, Primavera P6 routinely carries schedules two orders of magnitude
larger. Large EPC, construction, and defense programs are out of TruePPM's range
today, and we are not going to pretend otherwise.

## Mobile — no released app yet

- **Today:** the web UI is responsive, but there is nothing installable and no
  offline-capable shell you can add to a home screen. A React Native app already
  exists in the repository — five working screens (Projects, Schedule, Tasks, Time,
  Settings), offline sync, and authentication — and is under active CI, but it is an
  internal build with no store distribution and no public release. "No app yet"
  describes what you can install, not what has been written.
- **0.5:** an installable PWA with an offline shell — add to home screen, time entry
  and board reads without a signal.
- **0.6:** the in-progress React Native app above reaches GA on Android — Android
  phones first, tablets second — as the first mobile release anyone outside the
  project can install.
- **1.0:** iPhone and iPad parity.

## Integrations — thin, deliberately

MS Project XML round-trips today. Beyond that the surface is narrow:

- **0.4:** CSV / Excel import, and a personal, read-only, one-way Jira sync into My
  Work — coexistence, not migration.
- **0.5:** a one-time Jira migration import.
- **0.6:** breadth across the top-10 tools (Asana, Monday, Wrike, ClickUp, Trello,
  Notion, Linear, Basecamp) and full `.mpp` support.
- **0.7:** the specialist long tail — Primavera P6 XER/PMXML, OmniPlan, GanttProject,
  MPX/ProjectLibre.

There is no marketplace, and there will not be one soon. The internal plugin
architecture is planned for 0.7 and a public Extension SDK for 0.9. Redmine's
ecosystem is its main advantage over TruePPM and will stay that way for some time.

## Internationalization — English only, hardcoded

There is no i18n framework wired into the web app — no i18next, react-intl, or
equivalent — and UI strings are hardcoded English throughout. There is no locale
switcher, no translated string catalog, and no RTL support.

- **0.4:** the i18n framework decision itself
  ([#728](https://gitlab.com/trueppm/trueppm/-/issues/728)) — whether to commit to
  string externalization now or defer, made while the UI surface is still small
  because retrofitting extraction gets more expensive every release.
- **0.9:** i18n/l10n execution against whatever framework decision 0.4 makes, as part
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
  `PodDisruptionBudget` and `HorizontalPodAutoscaler` ship in the 0.4 Helm chart,
  both off by default. Celery-originated broadcasts reach WebSocket clients
  connected to any API pod, so horizontal API scaling is safe.
- **Celery beat is single-replica by design**, not a gap — exactly one Beat process
  fires the periodic drains, and running two would double-dispatch every job.
- **The bundled Valkey pod is single-node, with no replication or failover.** For
  real HA you disable it and bring your own: a replicated primary behind one
  stable endpoint (`REDIS_URL`) is the path to rely on today. **Sentinel** is
  configurable via the `TRUEPPM_VALKEY_*` settings but ships **experimental** in
  0.4 — wired and unit-tested, not yet verified against a live quorum failover.
  **Cluster mode is not supported** — TruePPM uses four logical databases and a
  clustered endpoint exposes only one. See
  [Valkey HA](/administration/valkey-ha/).
- **Postgres HA is not part of the chart.** Large-scale production hardening — HA
  Postgres and a dedicated highly-available Valkey deployment — remains on the
  pre-1.0 roadmap; today you bring your own HA database, the same as you would with
  most self-hosted software.

**If "no single point of failure" out of the box is a requirement, TruePPM is not
there yet** — every tier can be made HA, but you assemble it yourself. See
[Deployment](/administration/deployment/) and [Valkey
HA](/administration/valkey-ha/) for the how.

## Governance and portfolio — out of the OSS core by design

Not a gap so much as a boundary, but evaluators should know where it falls. The
following are enterprise-edition features and are **not** coming to the OSS core:
portfolio dashboards and health scores across many programs, demand intake, custom
roles, approval workflow chains, immutable audit trail, multi-tenancy, SAML/SCIM/LDAP
identity governance, and cross-program resource leveling.

What *is* in the OSS core: everything one project manager, program manager, or team
needs to run their own program — including
[basic SSO](/overview/sso-is-not-enterprise/), program rollup, and the full
scheduling engine. The line is
[adoption versus governance](/overview/principles/), and we state it explicitly
rather than leaving you to discover it at a pricing page.

## Maturity — the honest framing

TruePPM's first OSS release was May 2026. The current line is an alpha; 0.4 is the
first beta. OpenProject has roughly fifteen years, a company behind it, and a support
contract you can buy. Redmine has twenty.

What we offer against that: a published 3–4 week release cadence that has held across
every release so far, a public
[commit history](https://gitlab.com/trueppm/trueppm/-/commits/main), a tested scale
envelope, and this page. Those are the evidence available to a young project. Whether
they are enough is a reasonable thing to decide against us.

**Do not put a program you cannot afford to lose on TruePPM before the 0.4 beta.**
That is our own recommendation, and it is in the README too.

## Found something missing from this page?

That is a bug in the page, and we would like to fix it.
[Open an issue](https://gitlab.com/trueppm/trueppm/-/issues) — including if a claim on
[How TruePPM compares](/overview/how-it-compares/) is out of date or wrong about
another tool.
