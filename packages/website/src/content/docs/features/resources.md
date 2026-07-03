---
title: Resources & Skills
description: Maintain a Workspace resource catalog with skills and proficiency, build per-project rosters, and assign people to tasks with fractional capacity — with skill-fit and overallocation warnings.
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

## What a resource manager can do today

1. Maintain the Workspace resource catalog (name, email, role, capacity, calendar).
2. Maintain the Workspace skill catalog and tag resources with proficiency.
3. Build per-project rosters with role and capacity overrides.
4. Assign resources to tasks at fractional capacity.
5. Define per-task skill requirements and see skill-fit on assignment.
6. See overallocation warnings when someone is overcommitted.
7. View project utilization across the team.
8. Deactivate and restore resources; remove them from a roster (cascading task
   assignments when forced).

## API

The catalog and assignment surfaces are exposed under
`/api/v1/resources/`, `/api/v1/skills/`, `/api/v1/resource-skills/`,
`/api/v1/project-resources/`, `/api/v1/task-resources/`, and
`/api/v1/task-skill-requirements/`. Reading resources requires any authenticated user.
Editing the resource catalog requires the **Project Manager** or **Project Admin** role on
at least one project; editing the skill catalog, rosters, and task assignments requires
the **Resource Manager** role or above on at least one project.
