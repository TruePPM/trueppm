---
title: Board sprint panel
description: Active-sprint summary embedded above the Board lanes — goal, dates, burndown, velocity, and planning capacity in one collapsible surface.
documentedFor: "0.4"
---

:::note[Added in 0.3]
The **mid-sprint scope-change badge** and its **scope-change audit drawer**
were added in 0.3 (the agile team release), available since the `0.3.0-alpha.1`
pre-release (Jun 28, 2026). The rest of this page describes shipped
behavior.
:::

This page is for a Scrum Master or PM running an active sprint. When a project has
a sprint in progress, the Board shows a summary panel directly above the Kanban
lanes — the goal, the dates, the burndown, velocity (how much work the team
typically finishes per sprint), and planning capacity — so you can see how the
sprint is tracking without leaving the board to check the separate Sprints page.

## What you see

- **Header band** (always visible while the panel is open): the sprint's short id,
  its goal, its dates, which day of the sprint you're on, how many days remain, and
  how many points are committed.
- **Body** (collapsible):
  - **Burndown** — the same burndown chart shown on the [Sprint burndown](/features/sprint-burndown/)
    page, scoped to this sprint.
  - **Velocity sparkline** — a small chart of the team's last 8 completed sprints,
    with the most recent one highlighted. The caption shows the average velocity
    and how much it typically varies. As of 0.3, a sprint flagged to be left out of
    velocity (for example, a one-off "Sprint 0" setup sprint) still appears here
    but is marked, and does not count toward that average; the panel also reports
    how many sprints were left out.
  - **Capacity card** — how many points the team planned to take on for this
    sprint, compared with how many are actually committed, shown as on-plan /
    at-risk / over-capacity.

## Visibility

The panel is hidden in two situations:

1. The project runs on the **Waterfall** methodology — there is no sprint to
   summarize (see [Methodology presets](/features/methodology-preset/)).
2. The project has no sprint currently active — again, nothing to summarize.

By default, Viewers and Team Members see the panel collapsed, and anyone with the
Scheduler role or above sees it expanded. Whichever way you leave it, TruePPM
remembers your choice in this browser and uses it again on your next visit,
overriding the role-based default.

## Planning capacity

This is the team's planning ceiling — how many story points the team plans to take
into the sprint, set before the sprint starts by the Scrum Master or Resource
Manager. It is **distinct** from two other numbers you might see nearby:

- **Committed points** — captured the moment the sprint activates, from whatever
  is in the backlog at that instant, and fixed after that.
- **Available hours** — worked out from who is assigned and their time off;
  measured in hours, not points.

Planning capacity answers "how many points do we plan to take on?" — not "what
does the backlog hold right now?" or "how many hours is the team actually
available?" All three are useful at different points in the cadence.

### Who can edit it

- You can change it while the sprint is being planned or is active (a team's
  capacity may shift mid-sprint — time off, a new joiner). It is locked once the
  sprint is completed or cancelled.
- Only the **Scheduler role or above** can change it — capacity is the team's
  shared planning artifact, not a per-contributor field. Team Members and below
  can see the panel and the current planned value, but the editor is hidden from
  them, and the server refuses the change even if someone attempts it directly.
- Every change is recorded, so a coach or PM can review the history of capacity
  revisions.

## Mid-sprint scope changes

:::note[Added in 0.3]
This badge and its audit drawer were added in 0.3.
:::

When tasks are added to a sprint **after** it has started, the panel header shows
a warning badge counting how many — the scope the team did not agree to at
planning.

Clicking the badge opens a **read-only log** of these changes. Each row shows:

- **Who** added the task and **when**.
- The **task** itself, with a link straight to its card.
- How many **points** it was worth when it was added.
- Its **status** — accepted, pending, or rejected — so you can tell scope the team
  has already absorbed from a proposal still waiting on a decision.

This log is for visibility, not approval — you cannot accept or reject anything
from here. The same log is also reachable from the milestone side, via the
[scope-changed indicator](/features/sprint-milestone-rollup/#scope-change-audit-chip)
on the milestone rollup.

An added task also carries a neutral **Pending acceptance** tag on its board card
(and in the assignee's My Work list) until someone decides on it. Any team member
can tap the tag for a plain-language explanation — that the task was added after
the sprint started and will not count toward the committed plan until someone
accepts it. Tapping it only explains the situation; accepting or declining is
reserved for the Scrum Master, Product Owner, or an admin.

*Screenshot TODO: Board sprint panel header showing the `⚠ 3 tasks added
mid-sprint` badge, and the open scope-change audit drawer.*

### Sprint-scoped activity, and a heads-up when scope moves

:::note[Ships in 0.4]
Sprint scope on the board Activity rail, and the sprint-membership notification,
ship in **TruePPM 0.4**.
:::

The board's **Activity** feed can be narrowed to just the current sprint. Opened
from a sprint's board, it defaults to **"This sprint"** — with a **"Whole board"**
toggle to see the whole project's history instead — so you read what changed for
this sprint's tasks without scanning past everything else. A filter chip labeled
**"Scope changes"** makes the sprint-membership events easy to find on their own.
If a task is removed from the sprint, that removal still shows up in the sprint it
left, even after the task moves on.

Separately, whenever a task actually **enters or leaves an active sprint**,
everyone who can act on that change gets an **in-app notification**: the **Project
Manager** and **Project Admin**, plus the team's **Scrum Master** and **Product
Owner** — whatever their formal project role happens to be — minus whoever made
the change. That last point matters in practice: a Product Owner is often set up
with the ordinary Team Member role, so a notice that only looked at formal roles
would miss the very person it exists for. (The Resource Manager is *not* on this
list, since that role cannot accept or decline scope changes, so there is nothing
for them to do with the notice.)

This closes the gap where someone could quietly add a task to an active sprint
without the team noticing: the change is now both visible in the activity feed
*and* pushed to the people who can act on it. The notification arrives in-app by
default (with an email option), can be turned off per person in
[Notification settings](/features/settings/project-notifications), and honors
Do Not Disturb. It never fires for a sprint that is only planned, or one that is
completed or cancelled, or for an edit that changes nothing.

## Where to find it in the app

- Open any project's **Board**, at `/projects/:projectId/board`.
- Tab: **Board** — the second tab in the standard view order.

## For developers and integrators

The panel is a UI composition over data the rest of TruePPM already has — building
it added one new field, the team's planning capacity, and one new endpoint for the
mid-sprint scope-change log. These are the endpoints it reads and writes:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/v1/projects/{id}/sprints/` | Reads the project's sprint list to find the active one |
| `PATCH` | `/api/v1/sprints/{id}/` | Updates the planning-capacity field (gated to the Scheduler role and above) |
| `GET`  | `/api/v1/sprints/{id}/burndown/` | Burndown series for the active sprint |
| `GET`  | `/api/v1/projects/{id}/velocity/` | Rolling 8-sprint velocity for the sparkline |
| `GET`  | `/api/v1/sprints/{id}/scope-changes/` | Read-only audit of tasks added to the sprint after activation — backs the mid-sprint scope-change badge and drawer *(added in 0.3)* |
| `GET`  | `/api/v1/projects/{id}/board/activity?sprint={sprintId}` | Board activity feed narrowed to one sprint's scope — backs the "This sprint" activity rail *(ships in 0.4)* |

The scope-changes endpoint is the one genuinely new addition (added in 0.3); the
rest of the panel reads data that already existed. 0.4 adds an optional sprint
filter to the board activity feed, plus a notification event fired whenever a
task enters or leaves an active sprint, sent to everyone authorized to accept or
decline it.

## Related

- [ADR-0073](/architecture/decisions/) — Sprint planning capacity and Board panel
- [ADR-0037](/architecture/decisions/) — Sprint model (this panel completes the
  "slim banner" anticipated there)
- [ADR-0072](/architecture/decisions/) — Role ordinals extension point (all role
  checks here use the same rank comparison)
- [Sprint burndown](/features/sprint-burndown/), [Velocity panel](/features/velocity/),
  [Capacity preflight](/features/capacity-preflight/)
