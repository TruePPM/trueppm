---
title: Flow analytics
description: Methodology-neutral cumulative-flow diagram, weekly throughput, cycle/lead-time percentiles, and a throughput-based delivery forecast for continuous-flow teams.
---

A board-level panel that answers "how is work flowing?" without sprints or velocity. It surfaces a cumulative-flow diagram, a weekly throughput chart, cycle- and lead-time percentiles, and — for a continuous-flow board — a throughput-based delivery forecast. The metrics are **methodology-neutral**: they read the same task history whether the board runs on a sprint cadence or continuous flow.

:::note[0.3]
Flow analytics ships in **0.3** (the agile-team release). The panel is available on every board cadence; the throughput-based delivery forecast card is specific to continuous-flow (Kanban) boards, which have no sprint velocity to forecast from.
:::

## Where this lives in the story

On the [board](/features/board/), beneath the columns. The panel is **collapsed by default** (the open/closed state persists per project in `localStorage`), so it never adds friction for a contributor who doesn't want it — it is there when a Scrum Master or delivery lead wants the flow read, and out of the way otherwise.

## What you see

- **Cumulative-flow diagram (CFD)** — a daily stacked area of task counts by board band — Backlog, To Do, In Progress, Review, Complete — rendered downstream-first so Complete sits at the base. Widening bands signal where work is piling up; a flattening Complete band signals stalling throughput.
- **Weekly throughput** — a bar series of completed-item counts per week (`week_start` → `completed_count`). The team's delivery heartbeat, independent of estimate size.
- **Cycle / lead-time percentiles** — a P50 / P80 / P95 stat strip for both **cycle time** (work-start to done) and **lead time** (created to done). Percentiles, not averages, so a long tail is visible rather than hidden by the mean.
- **Throughput forecast** *(continuous-flow boards)* — a Monte-Carlo estimate over recent weekly throughput that headlines a P80 **"finish in ~N weeks — by &lt;date&gt;"** answer for the remaining backlog. It gives a Kanban team a forward delivery date without sprints or velocity. When there is not yet enough completed history to sample, the card says so (`insufficient_flow_history`) rather than guessing.

## Aggregate only — never individual

The historical distributions are **team-private** (the `flow_metrics` privacy signal, team-to-team audience). The panel reports flow for the *team*, never a per-person breakdown — there is no individual cycle-time leaderboard, by design. A reader below the metric's audience sees a plain "not available" state, not blurred or partial numbers, and an in-audience caption makes the "aggregate only" guarantee self-evident on the panel itself.

## Where to find it in the app

- Route: `/projects/:projectId/board` — expand the **Flow analytics** panel below the columns.
- The throughput-forecast card appears only when the project's [board cadence](/features/board/#board-cadence) is **Continuous flow (Kanban)**.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/projects/{id}/flow-metrics/?window={days}` | Cycle/lead-time percentiles, the daily CFD series, and the weekly throughput series — computed on read. `window` bounds the lookback. |

The response is empty (and flags `flow_metrics_suppressed`) for a reader below the metric's audience. The throughput forecast is served by the same project forecast read that powers the sprint forecast, discriminated by `forecast_basis: "throughput"`.

## Related ADRs

- [ADR-0130](/architecture/decisions/) — methodology-neutral flow metrics (the computed-on-read flow read)
- [ADR-0137](/architecture/decisions/) — the board flow-analytics panel
- [ADR-0104](/architecture/decisions/) — privacy signals (the team-to-team `flow_metrics` audience)
- [ADR-0164](/architecture/decisions/) — board cadence (sprint vs continuous flow)

## If you are…

- **A Scrum Master / delivery lead** — read the CFD for where work piles up and the cycle-time P95 tail for predictability; both are more honest than a single velocity number.
- **Running a Kanban team** — the throughput forecast is your delivery date: a P80 "by &lt;date&gt;" for the remaining backlog, refreshed as you complete work.
- **A contributor** — leave the panel collapsed; nothing here tracks you individually, and the board works exactly the same whether it is open or closed.
