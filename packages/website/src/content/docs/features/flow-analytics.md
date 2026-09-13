---
title: Flow analytics
description: Methodology-neutral cumulative-flow diagram, weekly throughput, cycle/lead-time percentiles, and a throughput-based delivery forecast for continuous-flow teams.
---

This panel is for a Scrum Master or delivery lead who wants to answer "how is
work flowing?" for a team that doesn't plan in sprints and story points, or wants
a second read alongside a team that does. It works the same way whether the team
runs on a sprint cadence or continuous flow, because it reads the same task
history either way rather than depending on sprints or velocity.

:::note[Added in 0.3]
Flow analytics was added in **0.3** (the agile-team release), available since the `0.3.0-alpha.1` pre-release (Jun 28, 2026). The panel is available on every board cadence; the throughput-based delivery forecast card is specific to continuous-flow (Kanban) boards, which have no sprint velocity to forecast from.
:::

## Where this lives in the story

On the [board](/features/board/), beneath the columns. The panel remembers whether
you left it open or closed the last time you looked at this project, and it opens
**collapsed** the first time, so it never adds friction for a contributor who
doesn't want it — it's there when a Scrum Master or delivery lead wants the flow
read, and out of the way otherwise.

## What you see

- **Cumulative-flow diagram (CFD)** — a chart most agile teams will recognize: a
  daily stacked area showing how many tasks sit in each board column (Backlog, To
  Do, In Progress, Review, Complete), with Complete drawn at the base. A widening
  band shows where work is piling up; a flattening Complete band shows work
  slowing down.
- **Weekly throughput** — a bar chart of how many items the team completed each
  week. The team's delivery heartbeat, independent of estimate size.
- **Cycle / lead-time percentiles** — a strip of numbers for both **cycle time**
  (how long a task takes from when work actually starts on it to when it's done)
  and **lead time** (how long from when a task is created to when it's done). Both
  are shown as **P50 / P80 / P95** — the time within which 50%, 80%, and 95% of
  tasks finished. Showing these percentiles instead of a single average means a
  few unusually slow tasks show up here instead of being hidden by the average.
- **Throughput forecast** *(continuous-flow boards only)* — using the team's
  recent weekly throughput, this estimates when the remaining backlog will be
  done, headlined as a P80 answer: **"finish in ~N weeks — by &lt;date&gt;"** —
  meaning there's an 80% chance of finishing by that date or earlier. It gives a
  Kanban team a forward delivery date without sprints or velocity. When there
  isn't yet enough completed history to make that estimate, the card says so
  rather than guessing.

## Aggregate only — never individual

These numbers are **team-private**: only members of the team can see them, and
the panel always reports flow for the *team*, never a per-person breakdown —
there is no individual cycle-time leaderboard, by design. Someone who isn't
allowed to see these numbers sees a plain "not available" message, never blurred
or partial numbers, and the panel makes clear to everyone who *can* see it that
what they're looking at is aggregate-only.

## Where to find it in the app

- Route: `/projects/:projectId/board` — expand the **Flow analytics** panel below the columns.
- The throughput-forecast card appears only when the project's [board cadence](/features/board/#board-cadence) is **Continuous flow (Kanban)**.

## For developers and integrators

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/projects/{id}/flow-metrics/?window={days}` | Cycle/lead-time percentiles, the daily CFD series, and the weekly throughput series — computed on read. `window` bounds the lookback. |

The response is empty (with a flag noting the caller isn't authorized to see it) for a reader who isn't on the team. The throughput forecast is served by the same project forecast endpoint that powers the sprint forecast, distinguished by a `forecast_basis` value of `"throughput"`.

## Related ADRs

- [ADR-0130](/architecture/decisions/) — methodology-neutral flow metrics (the computed-on-read flow read)
- [ADR-0137](/architecture/decisions/) — the board flow-analytics panel
- [ADR-0104](/architecture/decisions/) — privacy signals (the team-to-team `flow_metrics` audience)
- [ADR-0164](/architecture/decisions/) — board cadence (sprint vs continuous flow)

## If you are…

- **A Scrum Master / delivery lead** — read the CFD for where work piles up and the cycle-time P95 figure for predictability; both are more honest than a single velocity number.
- **Running a Kanban team** — the throughput forecast is your delivery date: an 80%-confidence "by &lt;date&gt;" for the remaining backlog, refreshed as you complete work.
- **A contributor** — leave the panel collapsed; nothing here tracks you individually, and the board works exactly the same whether it is open or closed.
