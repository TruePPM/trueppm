# Programs

A **program** is a named grouping of related projects owned by one PM or program
team. It is the OSS coordination unit that sits between standalone projects and
the Enterprise portfolio: programs let one PM manage several related projects as
a single working set, with shared membership, a shared backlog (#501,
forthcoming), and a future combined burndown.

!!! info "Edition"
    Programs are part of the **Community (OSS)** edition. Portfolio governance —
    multiple programs under PMO oversight, cross-program health rollups,
    approval workflows — is part of the Enterprise edition.

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

!!! warning "Program access is independent of project access"
    Adding someone to a program does **not** add them to the program's projects.
    Adding someone to a project does **not** put them in the program. Both
    memberships are explicit grants — this matches the principle of least
    privilege and keeps audit trails clean.

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

`/programs/:id` is a four-tab shell:

- **Overview** — the default landing tab. Shows the program health rollup (see
  below).
- **Backlog** — *coming next* (#501). Will be a shared pool of cross-project
  features / stories / tasks that any project in the program can pull from.
- **Projects** — the projects currently in this program. Click a project name
  to navigate to it. The `Remove` action detaches the project (it becomes
  standalone, untouched).
- **Members** — manage program-level membership. Roles use the same 5-role
  model as projects: Viewer, Team Member, Resource Manager, Project Manager,
  Project Admin (Owner).

The sidebar shows a `Program · {name}` line under each project that belongs to
a program.

## Program overview rollup

The Overview tab rolls up the health of the program's own projects into a single
view: a **program health dot** plus a strip of KPI cards. Which KPIs appear and
how they combine is controlled per program in **Settings → Rollup** (the enabled
KPI set is seeded by methodology and can be edited by a Program Admin).

**Aggregation policy** governs how the health bands and day-variances combine,
and what the program health dot reflects:

- **Worst-case** (default) — the program is only as healthy as its least-healthy
  project; a single critical project is not diluted.
- **Average** — the mean across projects.
- **Task-weighted** — the mean weighted by each project's committed task count.
- **Budget-weighted** — weights by project budget. *Not yet available* — until
  the cost model ships, this falls back to Average and the Overview notes it.

Count KPIs (critical tasks, at-risk tasks) and risk exposure (risk score) always
roll up as **program totals** regardless of policy — the total is the useful
number for an additive metric.

**Available KPIs today:** schedule health, milestone health, baseline variance,
schedule variance, critical tasks, at-risk tasks, risk score.

**KPIs that show "needs data" until a follow-up ships:** cost variance and budget
utilization require the cost/EVM model; P80 completion requires a saved Monte
Carlo run. If you enable one of these, its card stays visible with a short reason
so it is clear *why* it is blank rather than silently disappearing.

> The rollup is per-program only. Cross-program and portfolio rollups are an
> Enterprise capability.

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

| Action                          | Minimum program role |
|---------------------------------|---------------------|
| View program shell and tabs     | Viewer              |
| View program backlog (#501)     | Viewer              |
| Edit BacklogItems (#501)        | Team Member         |
| Pull BacklogItem to project (#501) | Resource Manager  |
| Add or remove projects          | Project Manager     |
| Manage program membership       | Project Manager     |
| Update program name / methodology | Project Manager   |
| Delete program                  | Project Admin (Owner) |

For details on the OSS / Enterprise boundary around programs and portfolios,
see [ADR-0070](../adr/0070-program-entity-oss.md) and the architecture
boundary in [Two-Repo Rule](../../CLAUDE.md#two-repo-rule).
