---
title: Programs
description: Lightweight OSS coordination unit for one PM managing several related projects — shared membership, shared backlog, and combined rollup KPIs.
---


:::note[0.2 — in progress]
This page documents functionality that ships in **TruePPM 0.2** (target Jun 8, 2026). It is not available on the current 0.1 release.
:::

A **program** is a named grouping of related projects owned by one PM or program
team. It is the OSS coordination unit that sits between standalone projects and
the Enterprise portfolio: programs let one PM manage several related projects as
a single working set, with shared membership, a shared backlog, and a rollup KPI
view across the program's projects.

:::note[Edition]
Programs are part of the **Community (OSS)** edition. Portfolio governance —
multiple programs under PMO oversight, cross-program health rollups, approval
workflows — is part of the Enterprise edition.
:::

## When to use a program

A PM with three to six related projects benefits from a program when:

- There is a single roadmap or umbrella initiative that all the projects feed.
- Work occasionally moves between the projects — a feature deferred from
  Project A might end up in Project B's next sprint.
- You want a single navigation path between the projects without bookmarking
  each one separately.

If you are running a single project, or a handful of completely unrelated
projects, you do not need a program. Projects without a program (the default)
are fully functional standalone.

## Creating a program

Open the sidebar PROGRAMS section and select **+ New program**, or navigate to
**/programs** and select **+ New program**. Fill in:

- **Name** — display name, e.g. "Phase 2 Modernization".
- **Description** — optional.
- **Methodology** — Hybrid (default), Waterfall, or Agile. The choice is a
  default for new projects created within the program; existing projects in
  the program keep their own methodology.

You are added as the program **Owner** automatically.

:::caution[Program access is independent of project access]
Adding someone to a program does **not** add them to the program's projects.
Adding someone to a project does **not** put them in the program. Both
memberships are explicit grants — this matches the principle of least
privilege and keeps audit trails clean.
:::

## Adding projects to a program

From a program's **Projects** tab, select **+ Add project**. The picker lists:

1. **Standalone projects** — projects with no program. Select one to add it.
2. **In another program** — projects that already belong to a different
   program. Selecting one will **move** it to this program.

You need at least **Project Manager** role on both the project and the program
you are adding it to. If you are moving a project from one program to another,
you also need Project Manager role on the source program. This three-way gate
prevents one side unilaterally reorganising the other side's container.

A project can belong to at most one program. The same project cannot be in
multiple programs at once.

## The program shell

`/programs/:id` is a three-tab shell:

- **Backlog** — a shared pool of cross-project work items that any project in
  the program can pull from. Supports four item types: epic, feature, story,
  and task. Each item moves through a lifecycle: **proposed → pulled →
  archived**. Pulling an item creates a linked project task in the chosen
  project and marks the backlog item as pulled. Requires at least Team Member
  role on both the program and the target project.
- **Projects** — the projects currently in this program. Click a project name
  to navigate to it. The `Remove` action detaches the project (it becomes
  standalone, untouched).
- **Members** — manage program-level membership. Roles use the same 5-role
  model as projects: Viewer, Team Member, Resource Manager, Project Manager,
  Project Admin (Owner).

The sidebar shows a `Program · {name}` line under each project that belongs to
a program.

## Program settings

Deeper program configuration lives under **/programs/:id/settings**:

- **General** — name, description, code, health, visibility, and the methodology
  default for new projects. The program lead is shown read-only. Edits are staged
  and committed through a save bar.
- **Access** — manage program membership: invite members, change roles, and remove
  members (the same membership model as the Members tab).
- **Projects** — the child projects in the program.
- **Rollup KPIs** — choose which indicators roll up across the program's projects —
  schedule health, schedule variance, critical-task counts, risk score, and more.
  Toggles save as you change them.
- **Risk policy** — program-wide risk rules: which dependency types are allowed
  (FS / SS / FF / SF), which risk fields are mandatory, and escalation thresholds.
- **Lifecycle** — close or reopen the program, and transfer sponsorship to another
  owner.

The rollup-KPI and risk-policy settings are backed by
`GET`/`PATCH /api/v1/programs/{id}/rollup-config/` and `/risk-policy/` respectively;
lifecycle actions map to `POST /api/v1/programs/{id}/close/`, `/reopen/`, and
`/transfer-sponsorship/`.

## Deleting a program

Only the Program Owner can delete a program. The delete dialog explicitly
shows the impact:

- All program members are removed.
- All projects in the program are detached (they become standalone — project
  data and project member lists are not affected).
- The program itself is permanently deleted.

You must type the program name to confirm. The cascade is atomic — there is no
intermediate state where some memberships are removed but not others.

## Roles and permissions

| Action                              | Minimum program role  |
|-------------------------------------|-----------------------|
| View program shell and tabs         | Viewer                |
| View program backlog                | Viewer                |
| Create / edit backlog items         | Team Member           |
| Pull backlog item to project        | Team Member (on both program and target project) |
| Add or remove projects              | Project Manager       |
| Manage program membership           | Project Manager       |
| Update program name / methodology   | Project Manager       |
| Delete program                      | Project Admin (Owner) |

For details on the OSS / Enterprise boundary around programs and portfolios,
see [ADR-0070](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0070-program-entity-oss.md).
