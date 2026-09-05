---
title: Migrating from Microsoft Project Online
description: What carries over from a Project Online plan, what degrades on import and how you will know, what TruePPM does not have yet, and a five-step evaluation you can run before September 30, 2026.
documentedFor: "0.4"
---

:::note[Ships in 0.4 — the evaluation path]
The MSPDI `.xml` import itself has shipped since 0.1. Three things this page leans on
ship in **0.4**, TruePPM's first beta, and are not in `0.3.0-alpha.3`: constraint-date
and actual-date import, the hosted read-only demo, and read-only share links. On the
current release you evaluate against your own install, and imported constraint dates
are dropped with a warning rather than applied.
:::

Microsoft retires Project Online on **September 30, 2026**. New PWA sites have been
blocked since April 1, 2026, and after the retirement date the projects and data in a
tenant are no longer reachable. Microsoft's own successor, Planner Premium, is built
for task coordination rather than scheduling: it has no critical path, no resource
leveling, and no earned value, and it caps a plan at 3,000 tasks.

This page is for the PM or PMO deciding what to do with those plans. It is deliberately
symmetrical — it lists what TruePPM loses against Project Online as plainly as what it
keeps — because a migration chosen on an advertisement gets reversed six months later.

## Start with the inventory, not the tool

Every migration guide published this year says the same thing, and it is right: before
you compare tools, list what your organization actually uses. Three lists matter:

1. **Active plans, by depth.** How many carry real dependencies and constraints, and
   how many are flat task lists with dates typed in. The second kind imports into
   anything. The first kind is what this page is about.
2. **Reports and dashboards people depend on.** Who receives a status report from
   Project Online today, how often, and what is on it. This is where TruePPM is
   weakest right now — see [What you will miss](#what-you-will-miss) below.
3. **Integrations.** Power BI, Teams, SharePoint task lists. TruePPM has a REST API,
   webhooks, and a read-only MCP server; it has no Power BI connector.

## What carries over

Export each plan from Project Online as **MSPDI XML** (Project desktop: *Save As →
XML*). TruePPM's [MS Project import](/features/msproject-import-export/) reads it and
builds a CPM-schedulable project:

- **The WBS**, summary tasks, and milestones, with outline structure intact.
- **All four dependency types** (FS, SS, FF, SF) with lead and lag on every link.
- **Durations** in working days, and the plan's **base calendar** with its
  non-working exceptions.
- **Start-no-earlier-than constraints** (`SNET`), applied as the engine's floor.
- **Actual start and finish dates**, so an in-flight plan keeps its progress.
- **Three-point estimates**, if your plan carries them in the standard fields, which
  feed [Monte Carlo](/features/monte-carlo/) directly — Project Online never had this.
- **Assignees**, matched or created by name. Not their rates, not their capacity.

The import lists what it dropped, per field family, so you can check the receipt
against your inventory rather than discovering a gap in a review meeting.

## What degrades on import, and how you will know

| In your plan | What happens | How it surfaces |
|---|---|---|
| Must Finish On, Finish No Later Than, Must Start On (the ceiling half) | **Dropped.** TruePPM honors one constraint type today, start-no-earlier-than. | A row-level warning naming each task and the MS Project constraint name it carried |
| As Late As Possible, Start No Later Than, Finish No Earlier Than | **Dropped**, same reason | Same warning |
| Deadline | **Dropped.** There is no deadline field yet | Listed in the import receipt |
| Baselines | **Reported, not imported.** Capture a TruePPM [baseline](/features/baselines/) once the schedule is in | Listed in the import receipt |
| Work, Cost, resource rates | **Dropped.** TruePPM schedules on duration and dependencies and has no cost model | Listed in the import receipt |
| Sub-day durations | **Rounded to whole working days** | Silently — check any task under one day |
| Resource leveling results | **Not reproduced.** The engine computes the schedule and does not level it | The imported dates are the pre-leveling network dates |

The constraint rows are the ones that matter for a contractual plan. The direction
TruePPM intends to take — honoring `FNLT`, `MSO`, and `MFO` alongside `SNET`, with a
separate soft deadline and negative float against it — is recorded in
[ADR-1049](/architecture/decisions/), proposed and not yet accepted. Until it ships, a
plan that leans on must-finish-on dates cannot be expressed here, and this page will
say so until it can.

## What you will miss

Read [What TruePPM doesn't do yet](/overview/what-it-does-not-do/) in full before you
decide. For a Project Online migrator the four that bite are:

- **No resource leveling.** Project Online levels; TruePPM computes a schedule that
  assumes everyone can do everything at once. Leveling within one program is planned
  for 0.6.
- **No status report.** A project has a health value and nothing a sponsor can read.
  The project status update — RAG, narrative, and the computed facts behind it, with a
  one-page PDF — is planned for 0.5. If your PMO's weekly report is the thing you are
  really migrating, wait for it or budget for producing it by hand until then.
- **No cost or earned value.** No rates, no budgets, no CPI. Planned for 0.8 to 1.0.
- **One constraint type.** See the table above.

## What you will gain

- **Monte Carlo in the core.** P50 / P80 / P95 finish dates and per-task sensitivity,
  computed by the same engine that computes the deterministic dates. Project Online
  never had this; the commercial add-ons that provide it are licensed separately.
- **The board and the schedule are one object.** A team that works in sprints moves
  cards; the PM's critical path moves with them. No parallel plan.
- **Your infrastructure, your data.** Apache 2.0, self-hosted, no per-seat license,
  OIDC login against your own identity provider.
- **An API that is the product.** Everything the web UI does is a REST or WebSocket
  call you can make yourself, plus a read-only MCP server for asking questions of the
  live schedule.

## Evaluate it in five steps

1. **Pick one real plan** with dependencies and at least one hard finish date. Export
   it as MSPDI XML.
2. **Import it** into the [hosted demo](/getting-started/try-it/) or your own install
   via [Bring your existing plan in](/getting-started/bring-your-plan-in/). Read the
   import receipt against your inventory.
3. **Compare the finish date** TruePPM computes with the one Project Online showed. A
   difference is usually a dropped constraint or a leveling delay; the receipt tells
   you which.
4. **Run Monte Carlo** on it and look at the P80. This is the number you did not have
   before.
5. **Try to produce the report** your sponsor gets today. If you cannot, that is the
   honest reason to wait for 0.5, and this page will change when it lands.

## Related

- [Bring your existing plan in](/getting-started/bring-your-plan-in/) — the importer decision table
- [MS Project import & export](/features/msproject-import-export/) — the full field-coverage matrix
- [What TruePPM doesn't do yet](/overview/what-it-does-not-do/) — the maintained gap list
- [How TruePPM compares](/overview/how-it-compares/) — including the head-to-heads it loses
