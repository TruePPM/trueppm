---
title: "Scheduler Conventions"
description: "Every modeling convention the CPM and Monte Carlo engine commits to — units, lag, constraints, links, progress, float, and sampling — with where each one differs from MS Project and Primavera P6."
documentedFor: "0.4"
---

**This page is a reference for evaluators and library users** who need to know
whether `trueppm-scheduler` models their schedule the way they expect. Each row is
one rule the engine implements today, with the issue or ADR that decided it.
Rows marked **Differs** are the ones where a schedule built in MS Project or
Primavera P6 can come out differently here. Everything else follows the
conventions those tools use.

The same list ships in the
[`trueppm-scheduler` README](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/README.md#conventions)
for PyPI readers. The narrative for each rule lives on
[CPM Scheduler](/features/scheduler/) and [Monte Carlo](/features/monte-carlo/).

## Units and calendars

| Rule | vs MS Project / P6 | Decided in |
|------|--------------------|------------|
| Durations and three-point estimates count **working days**, in **whole days only**. A sub-day duration or lag is rejected with `InvalidScheduleInput`. | **Differs** — both tools schedule in hours. | [#826](https://gitlab.com/trueppm/trueppm/-/issues/826) |
| `Calendar.hours_per_day` and `Calendar.timezone` are **inert**. They round-trip through serialization and change no computed date. | **Differs** — in MS Project, hours per day converts a day-denominated duration into working time. | [#4131](https://gitlab.com/trueppm/trueppm/-/issues/4131) |
| Lag counts **calendar days**. The resulting date snaps forward to the successor's next working day (backward for negative lag), so a weekend can absorb a short lag. | **Differs** — MS Project counts lag in working time by default and treats elapsed days (`2ed`) as the opt-in. P6 counts lag on a working calendar. | [#2534](https://gitlab.com/trueppm/trueppm/-/issues/2534); open question [#2535](https://gitlab.com/trueppm/trueppm/-/issues/2535) |
| With per-task calendars, a task's duration expands on its **own** calendar and a link's lag is consumed on the **successor's** calendar. | Same as MS Project's task calendars. | [ADR-0120](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0120-cross-project-dependencies-within-program.md) |

## Links and constraints

| Rule | vs MS Project / P6 | Decided in |
|------|--------------------|------------|
| All four link types (FS, SS, FF, SF) take a lead or lag. | Same. | — |
| A task driven by an **FF or SF** link stays contiguous and is right-aligned on its pinned finish, so its start moves back. As a result, CPM is not monotone in duration on a network with FF/SF links: a longer task can start earlier and pull an SS successor with it. | Same as MS Project. | [#3806](https://gitlab.com/trueppm/trueppm/-/issues/3806) (decided: keep) |
| An **SF** link finishes the successor at the *start* of the predecessor's start day. With zero lag, the successor's last working day is the day before. The rule is the same for a task predecessor and a milestone predecessor. | Same. | [#4145](https://gitlab.com/trueppm/trueppm/-/issues/4145) |
| A zero-duration **milestone** is an instant. A milestone driven by work sits at the end of its driver's finish day, and a milestone held by a floor sits at the start of that day. When a lag, or a predecessor's recorded finish on a non-working day, places the milestone after a weekend or holiday, it is shown at the start of the next working day. | Same. MS Project moves an elapsed lag that ends on non-working time to the next working time. | [#4079](https://gitlab.com/trueppm/trueppm/-/issues/4079), [#4173](https://gitlab.com/trueppm/trueppm/-/issues/4173) |
| The **only** date constraint is start-no-earlier-than, via `Task.planned_start`, snapped to the next working day. `planned_finish` is reserved and inert: there is no deadline, finish constraint, must-start-on, or as-late-as-possible. | **Differs** — MS Project has eight constraint types plus deadlines. P6 has primary and secondary constraints. | [#3345](https://gitlab.com/trueppm/trueppm/-/issues/3345), [#804](https://gitlab.com/trueppm/trueppm/-/issues/804) |
| An **SS or SF link *from* a summary task** is rejected with `InvalidScheduleInput`. FS and FF links from a summary are expanded to its leaves. | **Differs** — MS Project accepts any link type on a summary. | [ADR-0370](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0370-reject-ss-sf-from-summary-tasks.md) |

:::note[Milestone and SF rules in older releases]
The milestone-instant rule (#4079, with its weekend-lag reading from #4173) and
the SF anchor rule (#4145) are not in
`trueppm-scheduler` 0.4.0b4 or earlier. Those releases schedule a milestone as a
one-day task and place an SF successor one working day later.
:::

## Progress and actuals

| Rule | vs MS Project / P6 | Decided in |
|------|--------------------|------------|
| A **completed** task (`actual_finish` set, or `percent_complete` at 100) is pinned to its recorded dates verbatim, even when they fall on a non-working day. It is out of network logic and is never re-sampled in Monte Carlo. | — | [ADR-0136](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0136-completed-task-full-duration-span.md) |
| An **in-progress** task schedules only its remaining work, `duration − floor(duration × percent_complete / 100)` working days. That work runs forward from the data date (`status_date`) and is floored at `actual_start`, which is kept unsnapped. | — | [ADR-0132](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0132-data-date-aware-progress-forecasting.md) |

## Float and output

| Rule | vs MS Project / P6 | Decided in |
|------|--------------------|------------|
| `total_float` is the working-day span from the early start to the late start, and `is_critical` means exactly `total_float == 0`. | — | — |
| `free_float` inverts the forward constraint across **all four** link types, anchored on each successor's early date, and is capped at total float. A task with no live successor falls back to its total float, and completed successors are skipped. | Same definition. | [#1828](https://gitlab.com/trueppm/trueppm/-/issues/1828) |
| The order of `ScheduleResult.tasks` is **unspecified**. Look tasks up by `id`, never by position. | — | [#1862](https://gitlab.com/trueppm/trueppm/-/issues/1862) |

## Monte Carlo

| Rule | vs MS Project / P6 | Decided in |
|------|--------------------|------------|
| A three-point estimate samples a Beta distribution, **fitted by method of moments to the classic PERT mean `(O + 4M + P) / 6` and σ `(P − O) / 6`**. This is not the λ=4 Beta-PERT. Both have the same mean, but on a symmetric estimate the band here is about 12% narrower, so P80 and P95 land slightly earlier. On an estimate whose most-likely value sits at one end, the band is wider. | **Differs** from the λ=4 Beta-PERT that @RISK and Primavera Risk Analysis default to. Neither MS Project nor P6 samples on its own. | [#4133](https://gitlab.com/trueppm/trueppm/-/issues/4133) |
| Every sampled duration is **floored at the task's own `duration`**, so the optimistic tail below the plan is not expressed. To model finishing early, lower `duration`. | **Differs** — risk tools sample the whole estimate. | [#3765](https://gitlab.com/trueppm/trueppm/-/issues/3765) |
| No percentile precedes the CPM finish **on a network built only from FS and SS links**. On an FF/SF network a percentile can land earlier, because CPM itself is non-monotone there (see the FF/SF row above). | — | [#3806](https://gitlab.com/trueppm/trueppm/-/issues/3806) |
| A fixed `seed` reproduces P50/P80/P95 exactly **on the same numpy version and the same `trueppm-scheduler` version**. Upgrading either one can move seeded percentiles. | — | [#4099](https://gitlab.com/trueppm/trueppm/-/issues/4099) |
