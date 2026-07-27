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

## Mobile — no app yet

- **Today:** the web UI is responsive, but there is no installable app and no
  offline-capable mobile shell.
- **0.5:** an installable PWA with an offline shell — add to home screen, time entry
  and board reads without a signal.
- **0.6:** a native Android app (React Native / Expo + WatermelonDB), Android phones
  first, tablets second.
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
