---
title: Multi-team Sprints lens
description: Aggregated sprint health across every project where the user has open assignments.
---

:::note[0.1]
The multi-team Sprints lens shipped in 0.1.
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

`IsAuthenticated` only — scope is the user's own assignments, not an org-wide rollup. The cross-portfolio view (aggregating across programs for a PMO director) belongs in the Enterprise edition.

## Why this is OSS-shaped, not Enterprise

This is a single-team-lead use case (looking across their own assignments within their program), not a PMO portfolio rollup (looking across all programs for an entire organization). The distinction matters — `My Teams` is filtered to the user's own assignments across the projects they're active in. Portfolio-level aggregation across programs is the entry point to the Enterprise upsell.

## Related ADRs

- [ADR-0037](/architecture/decisions/) — Sprint model: data, API, and board integration (defines the `me/active-sprints/` endpoint and summary payload shape)

## If you are…

- **Maya** — covering two Scrum teams? The toggle gives you both sprints in one screen.
- **Sarah** — same, across the projects you allocate resources to.
- **Diana** — your single-project view of how your portfolio is trending today, without leaving the Sprints workspace.
