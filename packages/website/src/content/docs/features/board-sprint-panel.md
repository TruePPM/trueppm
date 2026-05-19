---
title: Board sprint panel
description: Active-sprint summary embedded above the Board lanes — goal, dates, burndown, velocity, and planning capacity in one collapsible surface.
---

When a project has an ACTIVE sprint, the Board view renders a sprint panel
directly above the Kanban lanes. The panel composes the existing burndown
chart, an inline 8-sprint velocity sparkline, and a `capacity_points`
planning editor so a Scrum Master or PM does not have to switch routes to
`/sprints` to see how the sprint is tracking against commitment.

## What you see

- **Header band** (always visible while the panel is rendered):
  sprint `SP-XXXXXXXX`, goal, dates, day-N-of-M, days-remaining, points
  committed.
- **Body** (collapsible):
  - **Burndown** — reuses [`<BurnChart sprintId={…}>`](/features/sprint-burndown/) in
    sprint-scoped mode.
  - **Velocity sparkline** — 64×24px SVG, up to 8 closed sprints, most recent
    bar emphasized; caption shows the rolling average ± stdev.
  - **Capacity card** — planning target (`capacity_points`) vs committed
    points snapshot, with an on-plan / at-risk / over-capacity status.

## Visibility

Hidden in two situations:

1. The project's methodology is `WATERFALL` — no sprint context, no panel
   (per [methodology preset](/features/methodology-preset/) — ADR-0041).
2. The project has no `ACTIVE` sprint — there is nothing to summarize.

Default open / collapsed state:

| Role               | Default       |
|--------------------|---------------|
| VIEWER, MEMBER     | Collapsed     |
| SCHEDULER+         | Expanded      |

User choice persists in `localStorage` under
`trueppm.board.${projectId}.sprintPanel.open` and overrides the role-based
default on subsequent visits.

## Planning capacity (`capacity_points`)

A new field on the `Sprint` model — the team's planning ceiling in story
points, set pre-activation by the Scrum Master / Resource Manager. It is
**distinct** from two existing quantities:

- `Sprint.committed_points` — snapshotted **on activation** from the
  current backlog; immutable after that.
- `services.capacity_summary(...)` — derived from resource allocations and
  PTO; reported in **hours**, not points.

`capacity_points` is the answer to "how many points do we plan to take?",
not "what does the backlog hold right now?" or "how many hours are the
team available?". All three are useful at different points in the cadence.

### Editability and RBAC

- Editable on `PLANNED` and `ACTIVE` sprints (a team's capacity may change
  mid-sprint — PTO, joiners). Locked on `COMPLETED` and `CANCELLED`.
- **Field-level RBAC: SCHEDULER+ writes only.** Capacity is the team's
  planning artifact, not a per-contributor field. MEMBER and below see
  the panel and the current planned value but cannot edit it; the inline
  editor is hidden in the UI and the server rejects the write at the
  serializer level.
- Every change is recorded in `Sprint.history` (django-simple-history) so
  a coach or PM can see the audit trail of capacity revisions.

## Where to find it in the app

- Route: any project Board, `/projects/:projectId/board`
- Tab: **Board** (the second tab in the canonical view order — ADR-0030)

## API endpoints touched

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/v1/projects/{id}/sprints/` | Reads the project's sprint list to find the active one |
| `PATCH` | `/api/v1/sprints/{id}/` | Updates `capacity_points` (field-gated to SCHEDULER+) |
| `GET`  | `/api/v1/sprints/{id}/burndown/` | Burndown series for the active sprint |
| `GET`  | `/api/v1/projects/{id}/velocity/` | Rolling 8-sprint velocity for the sparkline |

No new endpoints — the panel is a UI composition over existing data.

## Related

- [ADR-0073](/architecture/adr/) — Sprint planning capacity and Board panel
- [ADR-0037](/architecture/adr/) — Sprint model (this panel completes the
  "slim banner" anticipated there)
- [ADR-0072](/architecture/adr/) — Role ordinals extension point (all role
  checks here use the `>=` band contract)
- [Sprint burndown](/features/sprint-burndown/), [Velocity panel](/features/velocity/),
  [Capacity preflight](/features/capacity-preflight/)
