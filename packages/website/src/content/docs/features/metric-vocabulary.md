---
title: Metric vocabulary
description: What each health, forecast, load, risk and slip figure in TruePPM means, which endpoint owns it, and when it was true.
documentedFor: "0.5"
---

:::note[Ships in 0.5]
The `definitions` map, the `as_of` timestamps, the blocked count on the status
summary, the forecast's commitment fields (`commitment_date`,
`commitment_source`, `p80_delta_vs_commitment_days`), and the sprint burndown's
`burn_status_reason` ship in 0.5. In 0.4 the figures below exist on the same
endpoints, but without a definition, an `as_of`, or a commitment comparison,
and the My Work ship-date forecast can lag the project's own forecast by up to
a day. Also in 0.5: P80 completion computes (in 0.4 it is unavailable).
:::

The same project figure can appear in several places: the project header, the
overview, a home page, a report, or an answer from an MCP client. Each figure has
exactly **one** owner, an API endpoint that computes it. Every other surface reads
that value and only formats it, so two screens cannot show two different numbers
for one fact.

Each owning endpoint returns two extra things beside its figures:

- **`definitions`**: one sentence per figure, saying what it measures. The
  sentences are the ones on this page. A client shows the sentence it was given
  and does not write its own.
- **`as_of`**: when the figure was true. The Monte Carlo forecast has no separate
  `as_of`. Its `last_run_at` already says when the simulation ran, so that field
  is its `as_of`.

## The vocabulary

| Metric | Field | Owner | As of | Definition |
|---|---|---|---|---|
| Health band | `health_band` | `GET /projects/{id}/status-summary/` | `as_of` | The project's health: the project manager's own report when one is filed, otherwise critical when any incomplete leaf task is on the critical path, at risk when any incomplete leaf task has 5 or fewer working days of total float, and on track when neither holds. |
| At-risk tasks | `at_risk_count` | `GET /projects/{id}/status-summary/` | `as_of` | Incomplete leaf tasks with 5 or fewer working days of total float, including tasks already late (negative float). |
| Critical tasks | `critical_count` | `GET /projects/{id}/status-summary/` | `as_of` | Incomplete leaf tasks on the critical path. |
| Blocked tasks | `blocked_count` | `GET /projects/{id}/status-summary/` | `as_of` | Live tasks flagged blocked (a blocked reason is recorded): the rule the blocked list uses, counted in full rather than capped at the list's row limit. |
| P50 finish | `p50` | `GET /projects/{id}/monte-carlo/latest/` | `last_run_at` | The finish date half of the simulated schedules finish on or before. |
| P80 finish | `p80` | `GET /projects/{id}/monte-carlo/latest/` | `last_run_at` | The finish date 80% of the simulated schedules finish on or before. |
| P95 finish | `p95` | `GET /projects/{id}/monte-carlo/latest/` | `last_run_at` | The finish date 95% of the simulated schedules finish on or before. |
| P80 vs commitment | `p80_delta_vs_commitment_days` | `GET /projects/{id}/monte-carlo/latest/` | `last_run_at` | The P80 finish minus the commitment date, in calendar days measured in working time; positive means the forecast is later than the commitment. |
| Person load | `days[].load_pct` | `GET /projects/{id}/utilization/` | `as_of` | A person's booked hours on a working day divided by their capacity that day (hours per day times their units on this project), as a percentage; non-working days and calendar time off carry no capacity and are omitted. |
| Open risks | `open_risk_count` | `GET /projects/{id}/overview/` | `as_of` | Risks in the register whose status is open or mitigating. |
| Team utilization | `team_utilization_pct` | `GET /projects/{id}/overview/` | `as_of` | Booked hours across the project roster this week divided by the roster's working-time capacity this week, as a percentage. |
| Schedule performance | `schedule_health` | `GET /projects/{id}/overview/` | `as_of` | The schedule performance band from the SPI proxy (completed planned work divided by work planned by today); unknown when nothing is planned yet. Not the project health band. |
| Burn series | `series` | `GET /projects/{id}/burn/` | `as_of` | Per day, the remaining (burndown) or completed (burnup) task count or story points, replayed from task history. |
| Planned (baseline) series | `baseline_series` | `GET /projects/{id}/burn/` | `as_of` | Per day, the same quantity as planned by the active baseline; absent when the project has no active baseline with dates. |
| Task slip | `finish_delta_days` (`baseline_finish_variance_days` on task rows, the same computation) | `GET /projects/{id}/tasks/{task_id}/baseline/` | `as_of` | A task's slip: its forecast finish minus its active-baseline finish, in calendar days measured in working time; positive means late. |
| Sprint burn series | `snapshots` (`series` on My Work) | `GET /sprints/{id}/burndown/` | `as_of` | Per day of the sprint, the story points of its committed tasks that are not complete (a task's remaining points when set, else its story points), as recorded in that day's burn snapshot; pending mid-sprint additions count for nothing until accepted. |
| Sprint commitment | `sprint.committed_points` | `GET /sprints/{id}/burndown/` | `as_of` | The story points the sprint committed to, snapshotted when it was activated and never recomputed. |
| Sprint burn pace | `burn_status` | `GET /sprints/{id}/burndown/` | `as_of` | The sprint's burn pace: ahead or behind when the latest snapshot's remaining points are more than 10% of the committed points (at least 1 point) below or above the straight ideal line from the committed points to zero, on track otherwise, and no data when nothing was committed or no snapshot exists yet. |
| Sprint trend | `trend_points` (`trend_pts` on the active-sprints card) | `GET /sprints/{id}/burndown/` | `as_of` | The ideal line's remaining points for today minus the latest snapshot's remaining points; positive means ahead of the ideal line. |
| Sprint projected finish | `projected_finish_date` | `GET /sprints/{id}/burndown/` | `as_of` | Today plus the remaining points divided by the points burned per elapsed sprint day so far; null when nothing has burned yet or nothing remains. |
| My Work ship date | `signals.forecast.p80_finish` | `GET /projects/{id}/monte-carlo/latest/`, echoed by `GET /me/work/` | the driving project's `last_run_at`, as `signals.forecast.as_of` | The latest P80 finish among your member projects that are not drafts, each read from that project's latest Monte Carlo result: the same date its forecast endpoint serves. |

## Program rollup

One program's figures are owned by `GET /programs/{id}/rollup/`. It reads the
program's own projects only, never several programs. The response carries
`as_of` and a `definitions` map like the project endpoints. `definitions` always
holds `program_health`, plus one sentence for each KPI the program has turned on,
keyed by the KPI's name.

| Metric | Field | Owner | As of | Definition |
|---|---|---|---|---|
| Program health | `program_health` | `GET /programs/{id}/rollup/` | `as_of` | Each contributing project's schedule performance band (the SPI proxy: completed planned work divided by work planned by today) combined under the program's aggregation policy, leaving out projects with nothing planned yet; unknown when none has. Not the project health band. |
| Schedule performance (program) | `kpis.schedule_health` | `GET /programs/{id}/rollup/` | `as_of` | Each contributing project's schedule performance band (the SPI proxy) combined under the program's aggregation policy, leaving out projects with nothing planned yet. The same value as program health. |
| Milestone health | `kpis.milestone_health` | `GET /programs/{id}/rollup/` | `as_of` | Each contributing project's milestone band, combined under the program's aggregation policy: critical when an incomplete milestone's forecast finish has passed, at risk when one is due within 7 calendar days, on track otherwise; projects with no milestones are left out. Not the program health band. |
| Critical tasks (program) | `kpis.critical_tasks` | `GET /programs/{id}/rollup/` | `as_of` | Incomplete leaf tasks on the critical path, summed across the contributing projects. |
| At-risk tasks (program) | `kpis.at_risk_tasks` | `GET /programs/{id}/rollup/` | `as_of` | Incomplete leaf tasks with 5 or fewer working days of total float, summed across the contributing projects. |
| Risk score | `kpis.risk_score` | `GET /programs/{id}/rollup/` | `as_of` | Probability times impact of every open or mitigating risk, summed across the contributing projects. |
| Baseline variance | `kpis.baseline_variance` | `GET /programs/{id}/rollup/` | `as_of` | Each contributing project's forecast finish minus its active-baseline finish, in calendar days measured in working time, combined under the program's aggregation policy; positive means later than the baseline. |
| Schedule variance | `kpis.schedule_variance` | `GET /programs/{id}/rollup/` | `as_of` | Each contributing project's mean lateness of completed baselined tasks (actual finish minus baselined finish, in calendar days measured in working time), combined under the program's aggregation policy; positive means late. |
| Cost variance | `kpis.cost_variance` | `GET /programs/{id}/rollup/` | `as_of` | Earned value minus actual cost, summed across the contributing projects, in the workspace currency; negative means over budget. |
| Budget utilization | `kpis.budget_utilization` | `GET /programs/{id}/rollup/` | `as_of` | Actual cost across the contributing projects divided by their total budget; 1.0 means the whole budget is spent. |
| P80 completion | `kpis.p80_completion` | `GET /programs/{id}/rollup/` | `kpis.p80_completion.as_of` | The latest P80 finish among the contributing projects' own Monte Carlo forecasts. Not a joint simulation of the program, whose P80 would be this date or later. |

**Program health is the schedule performance rollup, not the project health
band.** It is the same value as the `schedule_health` KPI: each project's SPI
band combined under the program's aggregation policy. It does not roll up the
project health bands, because that band reads critical whenever any open leaf
task is on the critical path, which on real schedules is nearly every project
with open work. A program built from those bands would read Critical almost
always. A health report filed on the program does not change this figure.

**P80 completion** is the latest of the projects' own P80 finish dates. Each
project's P80 is the one `GET /projects/{id}/monte-carlo/latest/` returns for it.
The aggregation policy does not apply: a program finishes when its last project
does, and an average of finish dates is not a date. The entry also carries:

- `driver_project_id`: the project whose P80 is the latest.
- `as_of`: the oldest run among the forecasts it read. The figure is only as
  current as its oldest input.
- `projects_without_forecast`: how many projects have no forecast with a P80.
  They are left out, so the value is the latest P80 of the projects that have
  one.

## Commitment

The P80-versus-commitment figure compares the forecast with a commitment date.
The server picks the commitment with the first rule that applies, and returns
the sentence for that rule as `definitions.commitment_date`:

- The commitment is the active baseline's finish: the latest baselined finish date of any task.
- The commitment is the parent program's target date, because the project has no active baseline with dates.
- There is no commitment: the project has no active baseline with dates and no program target date.

`commitment_source` says which rule applied (`baseline`, `program_target`, or
`none`). The commitment is worked out on every response rather than stored with
the run. Activating a baseline or changing a program's target date therefore
updates the comparison without a new simulation.

## When a figure cannot be computed

A figure that is configured but cannot be computed is returned as `null` with a
reason. It is never left out of the response. For the commitment delta,
`p80_delta_vs_commitment_reason` is:

- `no_commitment`: no rule produced a commitment date.
- `no_forecast`: the latest run has no P80, for example because no task has an
  estimate the simulation can sample.

The overview's `team_utilization_pct` works the same way: when it is null,
`team_utilization_reason` explains why.

A sprint's `burn_status` of `no_data` comes with `burn_status_reason`:

- `no_commitment`: the sprint committed no story points when it was activated.
- `no_snapshots`: no burn snapshot has been written for the sprint yet.

It is null whenever a pace was computed.

The My Work `signals` block follows its own older rule: a card whose figure has
no backing data is left out of `signals` rather than sent as `null`. A missing
`signals.forecast` means none of your projects has a P80 forecast yet.

On the program rollup, a KPI keeps its `value` (`null`, or `unknown` for a band)
and gains a `reason`:

- `no_projects`: the program has no contributing project. `program_health`
  carries this as `program_health_reason`.
- `no_planned_work`: schedule performance, when no project has work planned by
  today. `program_health` carries this as `program_health_reason` too.
- `no_milestones`: milestone health, when no project has a milestone.
- `no_baseline`: the two variances, when no project has an active baseline with
  dates.
- `no_completed_work`: schedule variance, when no baselined task is complete yet.
- `no_forecast`: P80 completion, when no project has a forecast with a P80.

The cost KPIs keep their own reasons, described on the
[cost model](/features/cost-model/) page.

## Who sees the commitment

The forecast is readable by every project member, Viewer and up. When the
commitment comes from the parent program, those readers see the program's target
date, including members of the project who are not members of the program. Only
the date is shown. The program's name and its other projects stay behind program
membership. A soft-deleted program's date is never used.

## Figures without an owner yet

These figures appear on some screens but do not have an owning endpoint yet. They
should not be read as the forecast, load or burn figures above:

- A person's load across several projects, `/sprints/{id}/capacity/`, and the
  My Work `signals.utilization` figure (#4777).

Older screens that show schedule performance under the word "Health" are being
relabeled in #4780.

## Echoes

Some screens show a figure that another endpoint owns. They read the owner's
value and carry the owner's definition, so they cannot disagree with it:

- **My Work ship date** (`GET /me/work/`, `signals.forecast`) is the latest of
  your projects' P80 dates, each read the way `monte-carlo/latest/` reads it:
  the most recent run first, even when that run was started by a Member and was
  not saved to the forecast history. Its `as_of` is that run's `last_run_at`.
- **My Work sprint card** (`GET /me/work/`, `signals.sprint_burndown`) is the
  same series and pace as `GET /sprints/{id}/burndown/` for your
  soonest-ending active sprint.
- **Active-sprints card** (`GET /me/active-sprints/`) reports `trend_pts` with
  the burndown's formula. Until the sprint has a burn snapshot the card counts
  the committed points as the remaining points, where the burndown reports
  `trend_points` as null.

## Two figures that are easy to confuse

- **Health band** and **schedule performance** are different figures. The
  health band comes from the status summary. It folds in the project manager's
  own report and the float and critical-path counts. Schedule performance comes
  from the overview and is a ratio of completed planned work. It reads `unknown`
  when nothing is planned yet. A surface that labels it "Health" shows a second
  health value that can disagree with the first.
- **Sprint burn** and **project burn** are different figures. The sprint burn
  (`GET /sprints/{id}/burndown/`) counts only the sprint's committed tasks, from
  the daily snapshots. The project burn (`GET /projects/{id}/burn/`) counts
  every task in the project, replayed from task history. For a project with one
  active sprint the two still differ by every task outside the sprint.
- **Blocked count** on the status summary is the full count. The `count` on
  `GET /projects/{id}/blocked/` is the number of rows in that list, which stops
  at the list's row limit.

## Related

- [Monte Carlo forecasting](/features/monte-carlo/)
- [Resources](/features/resources/)
- [Interface & command palette](/features/interface/)
