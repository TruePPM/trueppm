---
title: Multi-team Sprints lens
description: Aggregated sprint health across every project where the user has open assignments.
documentedFor: "0.4"
---

:::note[0.1]
The multi-team Sprints lens shipped in 0.1.
:::

If you have open work on more than one team's sprint, the **My Teams** toggle on the Sprints view gives you a single screen showing how each of those sprints is doing, instead of clicking through projects one at a time. It's for anyone splitting their time across two or more teams — a PM covering two Scrum teams, a resource manager balancing several projects, or a PMO director keeping an eye on several at once.

Turning it on shows one card per project where you have unfinished work in an active sprint. Each card is sorted by how far behind its **burndown** is — the chart that tracks remaining work against the sprint's time — so the sprint most behind schedule shows first.

## Where this lives in the story

Steps 5–7 of the [hybrid PM flow](/the-story/) — bridges across projects. Single-project users never see the toggle; team leads (Alex supporting two Scrum teams, David balancing across PMs, Marcus reviewing the portfolio) all converge here.

## What you see

- **Toggle in the breadcrumb row** — `[ This project | My Teams (N) ]` — appears only when the user has assignments in 2+ active sprints
- **Per-team summary cards** — project name, sprint id, day-N-of-M, remaining points, capacity %, trend chip (`N pts ahead/behind`), forecast range
- **Sort order** — most-behind first; on-track sprints fall to the bottom so urgency reads from across the room
- **Click a card** — navigates to that project's full Sprints view

## Where to find it in the app

- Route: `/projects/:projectId/sprints` (toggle in the breadcrumb row, only visible when ≥ 2 active sprints exist)

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/me/active-sprints/` | One summary entry per project where user has open assignments in the active sprint |

Scope is the user's own assignments, not an org-wide rollup. The cross-portfolio view (aggregating across programs for a PMO director) belongs in the Enterprise edition.

## Who can see what

A card appears only for a project where you are still a current member — being
assigned a task there is not enough on its own. If your access to a project is
later removed, an old task can still point at you, but the card for that
project stops showing up; TruePPM checks your current membership, not just
whether a task happens to be assigned to you.

The **forecast range** on each card is the project's **velocity** — a rolling
average of how many story points the team completes per sprint, used to
predict how much they'll finish next — and it follows the same privacy rule as
the project's own Velocity and Forecast views: velocity is private to the team
by default, and a project's own PM or owner cannot see it until the team
chooses to share it upward. Because this lens spans several teams at once, that
check happens separately for each project's card — you might be an ordinary
team member on one project and the admin on the next, and each project decides
for itself what its own card shows you. If a project hasn't shared its
velocity, its card simply reads **Team-private** instead of a number. That is
different from a card that reads **no velocity yet**, which just means the
team hasn't closed enough sprints yet to have an average.

The rest of the card — day-N-of-M, remaining points, capacity, and the trend
chip — is not gated.

## Why this is OSS-shaped, not Enterprise

This is a single-team-lead use case (looking across their own assignments within their program), not a PMO portfolio rollup (looking across all programs for an entire organization). The distinction matters — `My Teams` is filtered to the user's own assignments across the projects they're active in. Portfolio-level aggregation across programs is the entry point to the Enterprise upsell.

## Related ADRs

- [ADR-0037](/architecture/decisions/) — Sprint model: data, API, and board integration (defines the `me/active-sprints/` endpoint and summary payload shape)

## If you are…

- **Alex** — covering two Scrum teams? The toggle gives you both sprints in one screen.
- **David** — same, across the projects you allocate resources to.
- **Marcus** — your single-project view of how your portfolio is trending today, without leaving the Sprints workspace.
