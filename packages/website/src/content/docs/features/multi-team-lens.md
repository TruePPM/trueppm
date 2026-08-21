---
title: Multi-team Sprints lens
description: Aggregated sprint health across every project where the user has open assignments.
documentedFor: "0.4"
---

:::note[0.1]
The multi-team Sprints lens shipped in 0.1.
:::

:::note[Ships in 0.4]
One part of this page is not in the latest release: the **velocity privacy gate
and membership check** described under [Who can see what](#who-can-see-what)
land in **TruePPM 0.4**, the first beta. Before 0.4 the lens returns every
project's velocity band to any caller holding an assignment — including a
project admin the team has not shared velocity with, and a member whose access
was revoked. Everything else on this page has shipped since 0.1.
:::

The `My Teams` toggle on the Sprints view aggregates active-sprint health across every project where the requesting user owns a non-complete task. Cards are sorted server-side by burndown deviation — most behind first.

## Where this lives in the story

Steps 5–7 of the [hybrid PM flow](/the-story/) — bridges across projects. Single-project users never see the toggle; team leads (Maya supporting two Scrum teams, Sarah balancing across PMs, Diana reviewing the portfolio) all converge here.

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

A card appears only for a project where you hold **live membership** — an
assignment on its own is not access. Project memberships are soft-deleted, so a
task you were assigned before your access was revoked keeps pointing at you; the
lens checks the membership rather than inferring it from the assignment, and a
revoked member sees no card for that project at all.

The **forecast range** on each card is the project's velocity band, and it
carries the same team-privacy posture as the project's own Velocity and Forecast
views ([ADR-0104](/architecture/decisions/)). Velocity is team-private by
default: the team reads it, and a project admin or owner does not until the team
shares it upward. Because the lens spans teams, the check runs **per project** —
you can be an ordinary member of one team and the admin of the next, and each
project's own setting decides its own card. A gated card reads `Team-private`
where the range would be, and returns `velocity_suppressed: true` with the three
point figures nulled. That is deliberately distinct from `no velocity yet`,
which means the team has no closed sprints to average.

The rest of the card — day-N-of-M, remaining points, capacity, and the trend
chip — is not gated.

## Why this is OSS-shaped, not Enterprise

This is a single-team-lead use case (looking across their own assignments within their program), not a PMO portfolio rollup (looking across all programs for an entire organization). The distinction matters — `My Teams` is filtered to the user's own assignments across the projects they're active in. Portfolio-level aggregation across programs is the entry point to the Enterprise upsell.

## Related ADRs

- [ADR-0037](/architecture/decisions/) — Sprint model: data, API, and board integration (defines the `me/active-sprints/` endpoint and summary payload shape)

## If you are…

- **Maya** — covering two Scrum teams? The toggle gives you both sprints in one screen.
- **Sarah** — same, across the projects you allocate resources to.
- **Diana** — your single-project view of how your portfolio is trending today, without leaving the Sprints workspace.
