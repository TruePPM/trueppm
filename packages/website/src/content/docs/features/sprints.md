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
- **Sprint Cadence timeline** — Closed sprints (greyed) → Active (sticky-left, ringed) → Planned cards. The strip is also a **selector**: click any card to load that sprint in the workspace (the selected card carries a navy ring).
- **Reviewing a past sprint** — selecting a **closed** sprint shows a read-only review: a five-card outcome row (goal verdict, committed/completed points, rolled-over, velocity Δ), the frozen historical burndown, the retrospective, and a **"what didn't ship"** list (each unfinished task with whether it carried to another sprint or was dropped). All of it reads from the consolidated sprint-outcome API; velocity figures stay team-private for readers outside the velocity audience.
- [Burndown chart](/features/sprint-burndown/), [Capacity preflight](/features/capacity-preflight/), [Velocity panel](/features/velocity/), and [Sprint backlog](/features/sprint-backlog/) populate the rest of the page when an active sprint is selected.
- **WIP limit** *(optional)* — set a per-sprint ceiling on in-flight work (tasks in *In progress* or *Review*) and the Board's [sprint panel](/features/board/) header shows a `WIP {count} / {limit}` chip that turns amber once the count exceeds the limit. Editable by Scheduler+ on planned and active sprints; locked once completed or cancelled. Distinct from per-column board WIP limits.

## Planning a sprint — the unified planning surface (ships in 0.3)

:::note[Ships in 0.3]
The unified planning surface, the planning bridge banner, and the incoming-carryover preview described below ship in 0.3 (the agile team release). They are not yet in a tagged build — see the [roadmap](/overview/roadmap/).
:::

Selecting a **planned** sprint in the cadence strip switches the workspace into a planning layout — everything the team needs to pull a sprint together lands on one screen instead of being scattered across tabs:

- **Backlog (left)** — the project [backlog](/features/sprint-backlog/) of sprint-less tasks, ready to pull into the planned sprint.
- **Capacity gauge** — the [Capacity preflight](/features/capacity-preflight/) panel, including the points chip and footer (0.3), so the team sees committed-vs-ceiling as they pull work in.
- **Incoming-carryover preview** — see below.
- **Planning bridge banner** — see below.

### Planning bridge banner

A planned sprint shows its draft **goal** next to the schedule **milestone it advances** — the milestone diamond, its name, and its target date — so the team can see *which contract date this sprint moves* before they commit a single point. Beneath it: **"N of M predecessor tasks land in this sprint"**, the count of the milestone's predecessor tasks that are already pulled into the sprint.

An inline **milestone picker** lets the team bind or change the advancing milestone without leaving the planning screen. Binding here sets `Sprint.target_milestone`, which is the same link that drives the live [sprint → milestone rollup](/features/sprint-milestone-rollup/) once the sprint activates.

### Incoming-carryover preview

A read-only sidebar lists the unfinished tasks from the **previous closed sprint** that rolled forward into this planned sprint, with the points each carried. It answers "what came in before we even started planning?" so the team plans on top of the real remaining commitment rather than a clean slate. It is backed by the `incoming_carryover` endpoint (see [API endpoints](#api-endpoints)).

> _Screenshot of the unified planning surface (backlog · capacity gauge · carryover · bridge banner) to be added once 0.3 ships._

## Where to find it in the app

- Route: `/projects/:projectId/sprints`
- Tab: **Sprints** (visible by default for HYBRID and AGILE projects per [methodology preset](/features/methodology-preset/))

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/v1/projects/{id}/sprints/` | List every sprint for a project |
| `POST` | `/api/v1/projects/{id}/sprints/` | Create a planned sprint (see [Plan Sprint dialog](/features/plan-sprint/)) |
| `GET`  | `/api/v1/sprints/{id}/` | Sprint detail with `target_milestone_detail` nested |
| `GET`  | `/api/v1/sprints/{id}/incoming_carryover/` | Unfinished tasks that rolled forward from the previous closed sprint, with points carried (ships in 0.3) |
| `POST` | `/api/v1/sprints/{id}/activate/` | PLANNED → ACTIVE; returns capacity warnings |
| `POST` | `/api/v1/sprints/{id}/close/` | Async close via outbox; returns 202 + request id |
| `POST` | `/api/v1/sprints/{id}/cancel/` | PLANNED → CANCELLED |

## Related ADRs

- [ADR-0036](/architecture/decisions/) — Hybrid PM philosophy and sprint model
- [ADR-0037](/architecture/decisions/) — Sprint model: data, API, and board integration
- [ADR-0041](/architecture/decisions/) — Methodology preset (drives tab visibility)

## If you are…

- **Maya (Scrum Master)** — the Sprint header is your home. Set a goal at planning, watch the day-of-N counter during execution, fire Close sprint at retro time. From 0.3, selecting a planned sprint gives you the whole planning screen — backlog, capacity, carryover, and the milestone bridge — in one place.
- **Tom (engineer)** — you'll mostly see the [Sprint backlog table](/features/sprint-backlog/) below. The header tells you which sprint you're in and how many days are left.
- **Raj (PM)** — the Advancing-to-Milestone card links directly into the Schedule view scrolled to the milestone task. The bridge between sprint cadence and contract dates lives there.
