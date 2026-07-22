---
title: Program Settings
description: Configure a program's identity, delivery model, rollup KPIs, cadence, risk policy, and lifecycle — and how each setting inherits from the workspace or is overridden per program.
---

:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**, available since the `0.2.0-alpha.1` pre-release (May 31, 2026). 0.2 is an alpha release; the first beta is planned for 0.4.
:::

A **program** is a container for the related projects one PM or program manager
runs together (ADR-0070). It is a **Community (OSS)** entity — programs group
projects, roll their health up to a single view, and carry shared policy that
their projects inherit. (Portfolio governance across *multiple* programs is a
separate, Enterprise concern and is not configured here.)

Every program has a **Settings** area at `/programs/:programId/settings` — one
scrolling page (ADR-0146) whose sections you can jump to from the settings nav:
General, Projects, Access, External stakeholders, Rollup KPIs, Cadence, Working
calendar, Risk & dependency policy, Attachments, Integrations, and Lifecycle.

## Inheritance: workspace default → program override

Many program settings are not standalone values — they **inherit the workspace
default and can be overridden per program**. When a program has no override of
its own, the control reads **Inherit (…)** and shows the value it would take from
the workspace. Set a value to override; clear it to fall back to inheritance. The
settings that cascade this way are:

- **Methodology** (ADR-0107) and **iteration terminology** (ADR-0116)
- **Estimation scale** (ADR-0510)
- **Public sharing** and **guest access** (ADR-0135) — see [Sharing & Access Inheritance](/administration/sharing-and-access/)
- **Duration change → percent complete** policy (ADR-0151)
- **Monte Carlo forecast-history** retention (ADR-0144)
- **Attachment policy** (ADR-0153)
- **Working calendar** (ADR-0441)

A workspace can also *enforce* some of these values so downstream scopes cannot
override them. **Enforce is an Enterprise capability** — in the community edition
an enforced policy degrades to a suggestion (no lock), so a program can always
set its own value.

### Access

Reading a program's settings requires membership on the program. **Writing them
requires the program Admin or Owner role** — the program API gates
`PATCH /api/v1/programs/:id/` and the dedicated policy actions at Admin. Program
roles are the 5-role model (Owner, Admin, Scheduler, Member, Viewer) and are
**separate from project roles**; see [Roles & Permissions](/administration/rbac/).

## General

The **General** section edits the program's identity and delivery model. Settings
here affect every project in the program.

| Field | Description |
|---|---|
| Program name | Display name shown across the program's views. |
| Program code | Short prefix used for task IDs and exports (e.g. `APOLLO-123`). |
| Accent color | Program accent swatch used in nav and health chrome. |
| Description | Free-text summary of the program's purpose. |
| Target date | The program's headline target finish date. |
| Program manager | The program lead — the person accountable for the program. |
| Health | Manual health override (On track / At risk / Critical), or **Auto** to let the [rollup](#rollup-kpis) compute it. |
| Methodology | Planning model for the program's projects. Inherits the workspace default unless overridden — see [Methodology presets](/features/methodology-preset/). |
| Iteration terminology | What the program calls its iteration container (Sprint, Iteration, Cycle…). Inherits the workspace default. |
| Estimation scale | The estimate scale (story points, hours, T-shirt…) projects inherit. Inherits the workspace default. |
| Allow guests | Whether guests may be added to this program's projects. Inherits the workspace value — see [Sharing & Access](/administration/sharing-and-access/). |
| Public sharing | Whether read-only view links may be shared. Inherits the workspace value. |
| Keep Monte Carlo run history | Whether the program retains past [Monte Carlo](/features/monte-carlo/) forecast runs. Inherits the workspace policy. |
| Run history limit | How many forecast runs to keep before the oldest are pruned. |
| Run attribution visible to | Who can see which member ran a forecast. See [Retention](/administration/retention/). |
| Duration change → percent complete | Whether editing a task's duration re-derives its percent complete, and the override policy (ADR-0151). Inherits the workspace value. |

## Projects

The **Projects** section is a bulk matrix of the projects assigned to this
program. Each project **inherits the program's methodology unless it overrides
it**, and the matrix lets you review and set the methodology and iteration label
across the program's projects at once. See [Methodology presets](/features/methodology-preset/).

## Access

The **Access** section manages **who can see and manage the program**, using the
5-role model. From here an Owner/Admin can invite members, change a member's
role, and remove members. The last remaining Owner cannot leave until another
Owner is assigned. Program membership is independent of the membership on the
projects inside the program. See [Roles & Permissions](/administration/rbac/).

## External stakeholders

The **External stakeholders** section records people **without a TruePPM
account** — client sponsors, vendors, reviewers — so they can be referenced in
`@program-stakeholders` mentions. Each entry has a **Name**, **Email**, and an
optional **Note**. This is a directory for mentions and context; email
notifications to external stakeholders are planned for a future release.

## Rollup KPIs

The **Rollup KPIs** section chooses which health signals roll up to the program
level (ADR-0169). Only the KPIs you enable appear on the program overview. The
available signals are Schedule health, Schedule variance (SV), Baseline
variance, Critical task count, Milestone health, At-risk tasks, Risk score, P80
date, Cost variance (CV), and Budget utilization. An **Aggregation policy**
controls how the member projects' health combines into the single program health
shown when General → Health is set to **Auto**. Editing the rollup config
requires the program Admin role. See [Program rollup](/features/settings/program-rollup/).

## Cadence

The **Cadence** section defines the program's recurring ceremonies — meeting
templates such as steering reviews or demos. Each ceremony carries a **name**,
**cadence**, **duration**, and **owner**, and an optional **phase-gate
calendar**. Ceremony instances are created when the program starts and linked to
the relevant milestones.

## Working calendar

The **Working calendar** section sets the calendar the CPM engine uses to
schedule the program's projects (ADR-0441). It **inherits the workspace default
unless you override it here**; a project can in turn override the program
calendar. See [Working calendars](/administration/working-calendars/).

## Risk & dependency policy

The **Risk & dependency policy** section governs cross-project risk within the
program (#529):

- **Slip policy** — how a slip on a cross-project dependency propagates to the
  dependent project (warn or block). Default: **warn**.
- **Auto-escalate after** — how many days a cross-project dependency risk may go
  unaddressed before it escalates. Default: **3 days**.

The risk-scoring matrix shown alongside these controls is a read-only reference.
These policy values are direct program settings — they are not inherited from the
workspace.

## Attachments

The **Attachments** section controls whether **task file uploads are allowed**
for this program's projects and **which file types** are permitted (ADR-0153).
It **inherits the workspace attachment policy unless you override it here**.
External links are always allowed regardless of this setting. See
[Attachment policy](/administration/attachment-policy/).

## Integrations

The **Integrations** section configures **program-wide webhooks and API tokens**,
which fire across every project in the program. Project-scoped integrations live
under each project's own settings instead. See [Webhooks](/features/webhooks/)
and the [MCP server](/administration/mcp-server/).

## Lifecycle

The **Lifecycle** section (shown as **Archive / Close**) holds the program's
lifecycle actions (#530). Every action here is logged and reviewable in the
[workspace audit log](/administration/audit-log/):

- **Close / Reopen** — end the program's active phase, or reopen a closed program.
- **Transfer sponsorship** — reassign the program to a new manager.
- **Split into sub-programs** — divide the program's projects into new programs.
- **Delete program** — permanently remove the program. This is a destructive,
  confirmation-gated action; before deleting, consider exporting first — see
  [Data export](/administration/data-export/).

## See also

- [Programs](/features/programs/) — what a program is and how it groups projects
- [Workspace Settings](/administration/workspace-settings/) — the defaults programs inherit
- [Project Settings](/administration/project-settings/) — the scope below a program
