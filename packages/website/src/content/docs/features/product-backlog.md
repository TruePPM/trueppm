---
title: Product backlog & scoring
description: The Product Owner's priority-ordered backlog — epics and stories, acceptance criteria, Definition of Ready, and WSJF/RICE prioritization.
---

:::note[Planned for 0.3 (Underway)]
The product backlog is part of the **0.3 "agile team"** milestone, which is still
underway. This page describes the feature as designed; some sub-screens (the scoring
table, the story drawer, and the epic rollup card) are still being built. Nothing here
has shipped in a tagged release yet.
:::

The product backlog is the **Product Owner's** home surface: a single, priority-ordered
list of the work a team will deliver, expressed in agile vocabulary — epics, stories,
acceptance criteria — with no WBS or critical-path jargon required. It will live at
**Projects → (a project) → Product backlog**.

## Where this lives in the story

The product backlog feeds [Sprint planning](/features/plan-sprint/): the Product Owner
grooms and orders work here, and the team pulls from the top of it into a sprint. It is a
read-only feeder to planning — the backlog never assigns work to a sprint directly
(sprint sovereignty is preserved; see [Sprints](/features/sprints/)).

## The grooming view

The grooming view will show stories grouped under their epics, ordered by priority, each
row carrying its Definition-of-Ready signal, an acceptance-criteria meter, and its story
points. A **grooming-health strip** across the top will summarize:

- **Definition of Ready** — the share of stories marked Ready
- **Ready for next sprint** — ready story points against the active sprint's capacity
- **Unestimated** — stories still missing points
- **Acceptance criteria** — criteria met across the whole backlog

A dashed **next-sprint ready line** will be drawn where the cumulative ready points reach
the active sprint's capacity, so the Product Owner can see at a glance what fits the next
sprint. The ready line is advisory — it never blocks the team from pulling a story.

## Work-item types

Every task will carry a **type**: Story, Task, Bug, Spike, or Epic. The type drives the
card icon, grouping, and filtering — it never partitions data, so existing work continues
to behave exactly as before (everything is a Task until you say otherwise).

**Epics** group stories through a *parent-epic* link that is **independent of the WBS** —
an epic can gather stories that sit anywhere in the schedule hierarchy. Epics are
**excluded from the schedule (CPM) and from capacity math**; an epic's dates and points
are rolled up from its child stories rather than scheduled in their own right.

## Managing epics

The grooming view is also where you will shape the epic structure itself — not just the
stories underneath it.

- **Add an epic** — an **+ Add epic** button in the header will open an inline input; type
  a name and press Enter to create the epic. It will appear as its own group immediately,
  even before any story is assigned to it, so you can lay out the epics first and fill them
  in later.
- **Edit an epic** — clicking an epic's name will open an **epic detail drawer** (the same
  side panel a story opens into) where you can edit the epic's **name** and **description**.
  Edits batch behind a **Save** bar that appears only once you have unsaved changes, exactly
  like the story drawer.
- **Delete an epic** — each epic group header will carry an actions (**⋯**) menu with a
  **Delete** action. Deleting an epic **never deletes its stories**: they move to the
  **Ungrouped** group instead, and the confirmation will state exactly how many stories are
  affected before you commit.

Assigning an *existing* story to an epic stays on the story drawer — set or change the
story's parent epic there. This section is for creating and reorganizing the epics
themselves.

Creating and editing epics will be open to the **Product Owner** facet (or an Admin and
above); **deleting** an epic will require **Admin and above** — a Product Owner can create
and edit epics but not delete them. See [Who can do what](#who-can-do-what).

## Acceptance criteria

Each story will have first-class, tickable **acceptance criteria** (with optional
Given/When/Then structure), edited from the story drawer. Criteria show an **"X of Y met"**
readiness count and keep a **sprint-review pass/fail trail** — who marked each criterion
met, and when — so "is this actually done?" is answerable at the review instead of from
memory.

The review trail stays on the team's product surface for the sprint review. It is **never
rolled up to a portfolio or PMO dashboard**, and it is shown as the criterion's status
with author attribution on drill-down — never as a per-person scoreboard.

## Definition of Ready

Each story will carry a Definition-of-Ready signal the Product Owner sets explicitly:

- **Idea** — captured, not yet refined
- **Refine** — being groomed
- **Ready** — ready to be pulled into a sprint

Marking a story **Ready** requires it to be estimated and to have **all** its acceptance
criteria met. This gate is **advisory**: it governs the Product Owner's *Mark ready*
action, not whether the team and Product Owner can jointly pull a not-yet-ready story into
a sprint when they choose to.

## Prioritization scoring

Each project will choose one prioritization model — **None**, **WSJF**, **RICE**, or
**Value / Effort**. With a model selected, you enter that model's inputs per story:

| Model | Inputs | Score |
|-------|--------|-------|
| WSJF | business value, time criticality, risk reduction, job size | `(value + criticality + risk) / size` |
| RICE | reach, impact, confidence, effort | `(reach × impact × confidence) / effort` |
| Value / Effort | value, effort | `value / effort` |

The score is computed and shown next to each story — it is never stored, so it can't go
stale. **Auto-rank** sorts the backlog by score in one click; afterward, **manual
drag-reorder always wins** (auto-rank is a one-time sort, not a lock). Switching models is
**non-destructive** — each model keeps its own inputs, so you can trial RICE without losing
your WSJF numbers.

Scores stay on the team's product surface. There is no cross-project or PMO score rollup —
prioritization is a planning input the team owns, not an upward productivity metric.

## Two backlogs, two orders

The **product-backlog priority** order belongs to the Product Owner. Inside a sprint, the
**team** arranges its own execution order: the sprint order is seeded from product-backlog
priority when the sprint starts, then the team can freely reorder it **without** changing
the product backlog. This is the standard dual-backlog model — the Product Owner owns
*what's valuable*, the team owns *how it executes*.

## Quick add

Capturing a story will take under 30 seconds: type a title, press Enter, and keep going —
no required fields. Stories land at the bottom of the backlog as a Story, ready to groom.

## Who can do what

| Action | Required role |
|--------|---------------|
| View the backlog | Any project member |
| Draft / tick acceptance criteria | Team Member or above |
| Set types, link epics, score, auto-rank, split stories | Project Manager (Admin) or above |
| Create or edit an epic (name, description) | Product Owner facet or Admin and above |
| Delete an epic | Admin and above (a Product Owner can create and edit, but not delete) |

Backlog management is gated to Project Manager and above today; the dedicated **Product
Owner** facet will arrive in 0.3 and slot into the same permission seam — it opens epic
create and rename, and story grooming, without granting the power to delete. See
[RBAC](/administration/rbac/) for the role model.

## Related

- [Sprint planning](/features/plan-sprint/) — pulling groomed, ready work into a sprint
- [Sprints workspace](/features/sprints/) — the team's execution surface
- [Methodology preset](/features/methodology-preset/) — agile / waterfall / hybrid tab visibility
