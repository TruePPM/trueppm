---
title: Metric vocabulary
description: What each health, forecast, load, risk and slip figure in TruePPM means, which endpoint owns it, and when it was true.
documentedFor: "0.5"
---

:::note[Ships in 0.5]
The `definitions` map, the `as_of` timestamps, the blocked count on the status
summary, and the forecast's commitment fields (`commitment_date`,
`commitment_source`, `p80_delta_vs_commitment_days`) ship in 0.5. In 0.4 the
figures below exist on the same endpoints, but without a definition, an
`as_of`, or a commitment comparison.
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
- The My Work `signals.forecast.p80_finish` figure and the sprint burn sources
  (#4778).
- The program rollup's metrics (#4779).

Older screens that show schedule performance under the word "Health" are being
relabeled in #4780.

## Two figures that are easy to confuse

- **Health band** and **schedule performance** are different figures. The
  health band comes from the status summary. It folds in the project manager's
  own report and the float and critical-path counts. Schedule performance comes
  from the overview and is a ratio of completed planned work. It reads `unknown`
  when nothing is planned yet. A surface that labels it "Health" shows a second
  health value that can disagree with the first.
- **Blocked count** on the status summary is the full count. The `count` on
  `GET /projects/{id}/blocked/` is the number of rows in that list, which stops
  at the list's row limit.

## Related

- [Monte Carlo forecasting](/features/monte-carlo/)
- [Resources](/features/resources/)
- [Interface & command palette](/features/interface/)
