---
title: Task Labels
description: Colored, filterable labels that categorize tasks across the board and schedule, independent of status, sprint, or WBS.
---

:::note[0.4]
Task labels ship in 0.4. This page describes the planned behavior; until 0.4 is tagged, treat it as the design of record.
:::

**Labels** are colored tags you attach to tasks to categorize work along a free axis — `bug`, `tech-debt`, `blocked-external`, `frontend` — orthogonal to status columns, sprints, and the WBS. A task can carry several labels, and the board can be filtered to any of them.

Labels are **project-scoped**: each project owns its own label vocabulary. They are distinct from **backlog tags** (the free-text tags on program-backlog intake items) — an item is *tagged* while it is being groomed in the backlog, then *promoted* into a task that carries *labels*.

## Where labels appear

- **Board cards** — colored pills in the card's badge row. Card density controls how many show: **compact** renders up to three color dots, **comfortable** shows up to two pills plus a `+N` overflow chip, and **detailed** shows them all.
- **Schedule task drawer** — the task's labels, with an inline control to assign existing labels or create a new one.
- **Board filter bar** — a **Label** facet joins the existing Assignee, Priority, and Due facets. Select one or more labels and the board narrows to cards carrying any of them; non-matching cards dim out. The facet appears only when the board has labeled cards.

## Creating and assigning labels

Any **team member or above** can create a label — coin `needs-design` mid-retro without filing a ticket. Each project has a soft cap on the number of label definitions (50 by default, configurable by the operator) to keep the vocabulary from sprawling.

Assigning a label to a task is a task edit: a member can label the tasks they can edit, and admins can label any task. Assignment is **idempotent** — attaching a label that is already there, or removing one that is not, is a safe no-op, so two people (or an integration) toggling different labels on the same task never clobber each other.

## Managing the catalog

Project **admins** curate the catalog from **Settings → Labels**: rename, recolor, reorder, and delete. Renaming or recoloring a label updates every card that carries it. Deleting a label removes it from every task it was on.

## Color and accessibility

A label's color is chosen from a fixed **8-color palette** (slate, teal, purple, blue, rose, amber, green, cyan). Each color renders as a theme-aware pill that meets WCAG 2.1 AA contrast in both light and dark mode, and every pill carries a leading color dot alongside its always-visible name — so color is never the only way to tell labels apart.

## Offline and real-time

Labels sync to the offline store like the rest of the schedule: the label catalog syncs as its own collection, and a task's label assignments ride the task's own version, so a labeled task reconciles correctly after working offline. When you are online, label changes broadcast over the project WebSocket so collaborators' boards update live.

## For integrations and agents

Labels are first-class API objects. A read-only MCP client (or any API consumer) can read a task's labels and filter by them today. Writing labels from an agent — attaching or detaching them — arrives with the MCP write surface in a later release.

## Not in the first release

- Labels do not yet appear in the **schedule PDF export** or color the **Gantt bars** — that is planned as a follow-up.
- **Saved board views** do not yet persist a label filter.
- Label colors are chosen from the fixed palette; free hex colors are not supported.
