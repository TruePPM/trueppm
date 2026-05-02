---
title: Sprints workspace
description: Sprint header, goal, milestone link, and the cadence timeline strip.
---

The Sprints workspace is the agile-side surface — Maya the Scrum Master and Tom the engineer live here. It composes five panels (header, goal, milestone link, timeline, backlog) into a single route at `/projects/:id/sprints`.

## Where this lives in the story

Step 5 ([Sprint planning](/the-story/#5-sprint-planning--the-team-pulls-work)) and Step 6 ([Execute](/the-story/#6-execute--daily-cadence-two-worlds-in-sync)) of the [hybrid PM flow](/the-story/).

## What you see

- **Sprint header** — H1 (`Sprint N — name`), state pill, Filter / Plan next / Close sprint actions
- **Sprint goal card** — narrative + day-N-of-M + task count + points committed
- **Advancing-to-milestone card** — milestone WBS, target date, days-out chip, deep-link to the Schedule view at the milestone task
- **Sprint Cadence timeline** — Closed sprints (greyed) → Active (sticky-left, ringed) → Planned cards
- [Burndown chart](/features/sprint-burndown/), [Capacity preflight](/features/capacity-preflight/), [Velocity panel](/features/velocity/), and [Sprint backlog](/features/sprint-backlog/) populate the rest of the page when an active sprint exists.

## Where to find it in the app

- Route: `/projects/:projectId/sprints`
- Tab: **Sprints** (visible by default for HYBRID and AGILE projects per [methodology preset](/features/methodology-preset/))

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/v1/projects/{id}/sprints/` | List every sprint for a project |
| `POST` | `/api/v1/projects/{id}/sprints/` | Create a planned sprint (see [Plan Sprint dialog](/features/plan-sprint/)) |
| `GET`  | `/api/v1/sprints/{id}/` | Sprint detail with `target_milestone_detail` nested |
| `POST` | `/api/v1/sprints/{id}/activate/` | PLANNED → ACTIVE; returns capacity warnings |
| `POST` | `/api/v1/sprints/{id}/close/` | Async close via outbox; returns 202 + request id |
| `POST` | `/api/v1/sprints/{id}/cancel/` | PLANNED → CANCELLED |

## Related ADRs

- [ADR-0036](/architecture/adr/) — Hybrid PM philosophy and sprint model
- [ADR-0037](/architecture/adr/) — Sprint model: data, API, and board integration
- [ADR-0041](/architecture/adr/) — Methodology preset (drives tab visibility)

## If you are…

- **Maya (Scrum Master)** — the Sprint header is your home. Set a goal at planning, watch the day-of-N counter during execution, fire Close sprint at retro time.
- **Tom (engineer)** — you'll mostly see the [Sprint backlog table](/features/sprint-backlog/) below. The header tells you which sprint you're in and how many days are left.
- **Raj (PM)** — the Advancing-to-Milestone card links directly into the Schedule view scrolled to the milestone task. The bridge between sprint cadence and contract dates lives there.
