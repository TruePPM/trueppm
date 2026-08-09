---
title: Resources & Skills
description: Maintain a Workspace resource catalog with skills and proficiency, build per-project rosters, and assign people to tasks with fractional capacity — with skill-fit and overallocation warnings.
documentedFor: "0.4"
---

TruePPM models the people who do the work as **resources**. Resources live in a
Workspace-wide catalog, carry **skills** at a proficiency level, join a **project
roster**, and get **assigned to tasks** at a fractional capacity. When you assign someone,
TruePPM surfaces soft warnings if their skills don't match the task or if they're
overcommitted.

:::note[0.1]
The resource and skill catalog shipped in 0.1 and is part of the **Community (OSS)**
edition. **Cross-program** resource leveling and portfolio-wide heat maps are part of the
Enterprise edition.
:::

## The resource catalog

A **resource** has a name, email, job role, an optional calendar (to model individual
availability), and a **max units** value expressing capacity — `1.0` is a full-time
equivalent, `0.5` is half-time. Resources are Workspace-level: create them once and use
them across projects. Removing a resource soft-deletes it, so historical assignments stay
intact, and it can be restored later.

## Skills and proficiency

A **skill** is a Workspace-level tag (optionally grouped into a category). Tag a
resource with the skills they have at one of three proficiency levels — **Beginner**,
**Intermediate**, or **Expert**. Skill names are de-duplicated case-insensitively, so
"React" and "react" resolve to the same skill.

Tag skills inline from a resource's detail panel: choose a proficiency, then search the
catalog under **+ Add skill**. Each selection is added immediately and the search clears,
so you can tag several skills in a row; skills already on the resource are hidden from the
results.

## Rosters and assignments

- **Project roster** — add resources to a project before (or without) assigning them to
  specific work. A roster entry can override the resource's job role or capacity for that
  project.
- **Task assignment** — assign a resource to a task at a fractional **units** value (e.g.
  `0.5` for half their capacity). Assigning someone who isn't yet on the roster adds them
  automatically.

## Assignments across projects

:::note[Ships in 0.4 — the Assignments view]
The **Assignments** view on a resource's detail panel will ship in 0.4 as part of
the **Community (OSS)** edition.
:::

Opening a person's card in the Workspace resource catalog will answer the first
question a resource manager has — *what is this person working on?* The detail
panel will gain an **Assignments** section that lists every task the resource is
assigned to, **across every project**, grouped by project. Each task row links to
that task in its project schedule, and each project heading links to that project's
allocation view, so you can drill from the catalog straight into the work.

Every row shows the task's status, percent complete, and the resource's allocation
on that task (the raw `units` fraction of their capacity). A neutral summary — for
example *"3 tasks across 2 projects"* — sits at the top. The view is **read-only**:
it projects the assignments that already exist and lets you read the load yourself.
It does **not** compute a utilization score, flag overallocation, or roll up across
programs — cross-program resource leveling and portfolio heat maps remain part of
the Enterprise edition.

Because task and project names are project-scoped, the Assignments section is
visible only to **resource managers** — org admins (Admin or Owner on at least one
project). Other users still see the rest of the resource card (role, capacity,
skills) but not the assignments list.

## Skill-fit and overallocation warnings

You can attach **skill requirements** to a task — the skills (and minimum proficiency) the
work needs. When you assign a resource, TruePPM evaluates the fit and returns it with the
assignment:

- **Exact** — the resource meets every requirement.
- **Partial** — some requirements met, some short on proficiency.
- **Missing** — the resource lacks one or more required skills (listed explicitly).

Separately, if a resource's committed allocation across active tasks exceeds their max
units, the assignment comes back with an **overallocation** warning. Both checks are
**soft** — they inform the assigner but never block the assignment, so you stay in control.

## Team utilization on the project Overview

The project Overview carries a **Team utilization** KPI card: this week's committed
load as a percentage of the team's working capacity. It is computed from the same
calendar-aware engine as the resource heatmap — hours per day × units × working
days, with a resource's own calendar winning over the project's — so the Overview
card and the heatmap cannot disagree about how loaded a team is.

Three details are worth knowing:

- **The window is the current week (Monday–Sunday).** The card answers "how loaded
  is this team *now*", so work scheduled for next month does not raise it. A
  project-lifetime average would read as calm straight through a crunch week.
- **Everyone measured counts on both sides.** The population is the project roster
  plus anyone holding an assignment this week. A rostered person with no
  assignments is idle capacity and lowers the percentage; someone assigned without
  being on the roster still brings their own capacity, so they cannot show up as a
  phantom overallocation. A per-project **capacity override** on the roster wins
  over the resource's default max units.
- **A task's load is measured over its full span, not its remaining work.**

  :::note[Ships in 0.4]
  Windowing utilization on the task **span** rather than the remaining-work
  window ships in **TruePPM 0.4**, the first beta. It is not present in the
  current release: before 0.4, an in-progress task's contribution to the
  heatmap and the Team utilization card shrinks as `percent_complete` rises,
  and can drop out of the window entirely once its remaining-work window no
  longer intersects the query range.
  :::

  The heatmap and the Team utilization card both window a task's assignments
  on its **span** (`scheduled_start` through finish — see [the bar vs. the
  remaining-work window](/features/schedule/#the-bar-vs-the-remaining-work-window)),
  not on the narrower *remaining-work* window that `early_start` shrinks
  toward as a task approaches completion. A person's allocation on a task
  does not shrink just because they finished part of it — reporting progress
  moves a task closer to done; it does not delete the load they were
  assigned in the first place.

**0%** is a real reading — it means nobody is allocated this week. When the ratio
is genuinely undefined the card is muted and says why, rather than showing a blank:

| The card says | It means |
| --- | --- |
| `Needs people on the project roster` | The project has no roster and no assignments, so there is nothing to measure. |
| `Roster has no working hours this week` | Everyone on the roster is at zero capacity, or every calendar is closed for the whole week. |

Clicking the card opens the Team view, which is available to the **Scheduler** role
and above; for a Member or Viewer the card is a static read rather than a link into
a permission error.

## What a resource manager can do today

1. Maintain the Workspace resource catalog (name, email, role, capacity, calendar).
2. Maintain the Workspace skill catalog and tag resources with proficiency.
3. Build per-project rosters with role and capacity overrides.
4. Assign resources to tasks at fractional capacity.
5. Define per-task skill requirements and see skill-fit on assignment.
6. See overallocation warnings when someone is overcommitted.
7. View project utilization across the team, on the resource heatmap and as a
   this-week percentage on the project Overview.
8. See, from a resource's card, every task they are assigned to across all
   projects — grouped by project, read-only (ships in 0.4).
9. Deactivate and restore resources; remove them from a roster (cascading task
   assignments when forced).

## API

The catalog and assignment surfaces are exposed under
`/api/v1/resources/`, `/api/v1/skills/`, `/api/v1/resource-skills/`,
`/api/v1/project-resources/`, `/api/v1/task-resources/`, and
`/api/v1/task-skill-requirements/`. Reading resources requires any authenticated user.
Editing the resource catalog requires the **Project Manager** or **Project Admin** role on
at least one project; editing the skill catalog, rosters, and task assignments requires
the **Resource Manager** role or above on at least one project.

A read-only cross-project assignments feed for one resource is exposed at
`GET /api/v1/resources/{id}/assignments/` (ships in 0.4). Unlike
`/api/v1/task-resources/?resource=`, it is **not** scoped to the caller's own
projects — it returns the full cross-project set — so it requires org-admin
(resource-manager) access.
