# trueppm-scheduler

[![PyPI version](https://img.shields.io/pypi/v/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![CI](https://gitlab.com/trueppm/trueppm/badges/main/pipeline.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

**Project-schedule math as a library — critical path and delivery-risk forecasting, without a 500 MB desktop app or a SaaS subscription.**

Answer the two questions every plan has to answer:

- **"What's the earliest this can finish, and which tasks can't slip?"** — a full forward/backward critical-path pass computes early/late dates, total and free float, and flags the tasks on the critical path.
- **"How confident are we in that date?"** — Monte Carlo simulation turns three-point estimates into a P50/P80/P95 forecast, so you can commit to a date you'll actually hit instead of the best-case one.

It's pure Python with just `networkx` and `numpy` underneath — no Django, no web server, no GUI. Drop it into a backend, a data pipeline, a Jupyter notebook, or a CLI and get the same engine that powers the [TruePPM](https://trueppm.com) platform.

### Why reach for this

- **Real scheduling semantics, not a toy.** All four dependency types (finish-to-start, start-to-start, finish-to-finish, start-to-finish) with lead/lag on every link — most lightweight schedulers only do finish-to-start, which cannot express an overlap or a wait without faking it with a dummy task.
- **Working-time aware.** A built-in working-day calendar skips weekends and honors holiday exceptions, so durations resolve to real delivery dates.
- **Risk forecasting built in.** PERT-Beta Monte Carlo (a Beta moment-fitted to the classic PERT mean and σ = (P − O)/6 — see [Conventions](#conventions)), numpy-vectorized at ~10k runs/sec — the difference between "due March 3" and "70% likely by March 3, 95% by March 14."
- **Fails loud on bad input.** Cycle detection that names the offending task IDs, plus up-front validation of durations, lag, and project span — no silent wrong answers, no spinning on a degenerate graph.
- **Embeds anywhere.** Two dependencies, no framework. Serialize a plan to JSON, schedule it, and read back structured results.

## Features

- Forward/backward CPM pass with all four dependency types (FS, SS, FF, SF), total/free float, and critical-path flagging
- Calendar-aware working-day arithmetic (weekend skip + holiday exceptions), with optional per-task calendars for mixed-team schedules
- Monte Carlo schedule-risk simulation via PERT-Beta distributions — method-of-moments fit to the classic PERT mean and σ = (P − O)/6, not the λ=4 Beta-PERT (numpy-vectorized, ~10k runs/sec) → P50/P80/P95 completion dates
- Hybrid agile/waterfall forecasting — mark a task `delivery_mode=SCRUM` with a `story_points` estimate and Monte Carlo samples its duration from the team's own velocity history instead of a per-task PERT guess, so a project can mix sprint-delivered and traditionally-estimated work in one simulation
- Explainable results — `derive_value()` answers "why is this date what it is?" for any early/late/float value, naming the exact predecessor, dependency type, and lag that won, plus every constraint it beat
- JSON round-tripping for plans (`Project.from_json()` / `Project.to_json()`)
- CLI: `trueppm-scheduler schedule` / `trueppm-scheduler monte-carlo`

## Install

```bash
pip install trueppm-scheduler
```

Requires Python 3.11+.

## Quick start

```python
from datetime import date, timedelta
from trueppm_scheduler import schedule, Calendar, Project, Task, Dependency, DependencyType

calendar = Calendar()  # Mon–Fri, no holidays (whole-day scheduling)
task_a = Task(id="t-1", name="Design", duration=timedelta(days=5))
task_b = Task(id="t-2", name="Build",  duration=timedelta(days=10))
dep = Dependency(predecessor_id="t-1", successor_id="t-2", dep_type=DependencyType.FS)

project = Project(
    id="p-1",
    name="My Project",
    start_date=date(2026, 1, 5),
    tasks=[task_a, task_b],
    dependencies=[dep],
    calendar=calendar,
)

result = schedule(project)
build = next(t for t in result.tasks if t.id == "t-2")
print(build.early_finish)  # 2026-01-23 (15 working days from 2026-01-05, across two weekends)
```

> **Scheduling granularity.** The engine schedules in whole working-day units.
> `Calendar.hours_per_day` and `Calendar.timezone` round-trip through
> serialization for API parity but are **not** consumed by the CPM or Monte Carlo
> passes — they do not change any computed date. Sub-day scheduling is a future
> change.

### Duration and lag are counted in different units

This trips people up, so it is worth stating plainly:

| Input | Unit |
|-------|------|
| `Task.duration` (and every PERT estimate) | **Working days** — weekends and calendar exceptions are skipped |
| `Dependency.lag` | **Calendar days** — the offset is applied as elapsed time, and only the resulting date is then snapped forward to the next working day |

So a 5-working-day task starting Monday finishes Friday, not the following
Tuesday. But a 2-day FS lag after a Friday finish does **not** buy two working
days of wait — the weekend absorbs it:

```python
# Predecessor finishes Friday 2026-01-09, Mon–Fri calendar, FS link.
#
#   lag=0d  → successor starts Mon 2026-01-12   (1 working day later)
#   lag=1d  → successor starts Mon 2026-01-12   (1 working day later)
#   lag=2d  → successor starts Mon 2026-01-12   (1 working day later)
#   lag=3d  → successor starts Tue 2026-01-13   (2 working days later)
#   lag=4d  → successor starts Wed 2026-01-14   (3 working days later)
```

If you need a wait of *n* working days, size the lag against the calendar the
successor will actually land on — or model the wait as a zero-resource task,
which is duration-counted and therefore calendar-aware end to end.

Negative lag (lead) is supported and follows the same calendar-day rule: the
candidate date snaps **forward** to the next working day too, never backward.
A lead that pulls the candidate into a weekend does not borrow the Friday
before it — it lands on the Monday after:

```python
# Predecessor A is 6 working days starting Mon 2026-01-05, so it finishes
# Mon 2026-01-12. FS link, lag=-3 (a 3-day lead).
#
#   candidate = A.finish + 1 day - 3 days = Sat 2026-01-10
#   Sat is non-working, so it snaps forward -> successor starts Mon 2026-01-12
#
# Not Fri 2026-01-09 — the engine never snaps a lead or lag backward.
```

### Per-task calendars

By default every task is scheduled on the single `Project.calendar`. A task can
instead opt into its own working week — useful when one schedule spans teams or
projects that keep different calendars:

```python
seven_day = Calendar(working_days=0b111_1111)  # every day is a working day
support = Task(id="t-3", name="Hotfix", duration=timedelta(days=3), calendar_id="ops")

project = Project(
    id="p-1",
    name="My Project",
    start_date=date(2026, 1, 5),
    tasks=[task_a, support],
    calendar=Calendar(),                 # pass-level default (Mon–Fri)
    calendars={"ops": seven_day},        # registry tasks opt into by id
)
```

Conventions:

- **Duration** arithmetic uses the task's *own* calendar (`calendar_id` → entry in
  `Project.calendars`). A `calendar_id` of `None` uses the pass-level
  `Project.calendar`. When `Project.calendars` is non-empty, a `calendar_id`
  with no matching entry raises `InvalidScheduleInput` — a typo is refused, not
  scheduled on the wrong working week. With no registry (`None` or empty) a set
  `calendar_id` is ignored and the task uses `Project.calendar`.
- **Lag** on a dependency edge is applied as calendar days (above) and then
  snapped on the **successor's** calendar: the constraint lands where the wait is
  actually consumed.
- It is fully backward compatible — a project with no `calendars` registry
  schedules byte-for-byte as before.
- Both passes honor them: the CPM `schedule()` pass (early/late dates, float,
  criticality) and `monte_carlo()`. A fully deterministic mixed-calendar project
  simulates to precisely its CPM finish date, so the two agree by construction.

See [the full documentation](https://docs.trueppm.com/features/scheduler) for CPM output fields, Monte Carlo usage, and CLI reference.

## Explaining a result

The CPM pass picks the `max` (forward) or `min` (backward) of several candidate
constraints for each date, then moves on — it doesn't remember which one won.
`derive_value()` replays that decision for a single task and value, and names
the constraint that actually set it:

```python
from trueppm_scheduler import derive_value, Quantity

d = derive_value(project, task_id="t-2", quantity=Quantity.EARLY_START)
print(d.value, d.binding.kind, d.binding.source_task_name, d.binding.dep_type)
# 2026-01-12 predecessor_fs Design FS — Build starts when Design finishes on an FS link

for c in d.contributions:
    print(c.kind, c.source_task_name, c.is_binding)  # every constraint considered, winner flagged
```

This is what lets a UI (or an AI agent) answer "why is this task starting on the
17th?" with the actual dependency instead of a guess — the value returned is
computed the same way the engine computed it, not re-derived heuristically.

## Mixing agile and waterfall in one schedule

Real programs are rarely pure CPM or pure Scrum. A task can opt into
sprint-based uncertainty instead of a three-point estimate:

```python
from trueppm_scheduler import DeliveryMode, Task

sprint_work = Task(
    id="t-4",
    name="Checkout redesign",
    duration=timedelta(days=10),      # fallback if delivery_mode is later cleared
    delivery_mode=DeliveryMode.SCRUM,
    story_points=21,
)

project = Project(
    ...,
    tasks=[task_a, task_b, sprint_work],
    velocity_samples=[18, 22, 15, 24, 19],  # the team's last five sprints
)
```

`monte_carlo()` then samples `sprint_work`'s duration from how many sprints the
team's own velocity history says 21 points takes — not from a PERT guess nobody
on the team would stand behind — while every other task in the same run still
uses its three-point estimate. `DeliveryMode.WATERFALL` (the default) is
unaffected; mixing modes is opt-in per task.

## Interpreting the output

The two entry points answer different questions, and their outputs are not the
same kind of thing. Reading a `schedule()` date as if it were a commitment is
the single most common way to misuse this library.

**`schedule()` returns one date, and it is the optimistic one.** The CPM finish
is the *earliest feasible* completion — the date you get if every task takes
exactly the duration you estimated, no task slips, and no risk fires. It is a
point on a distribution, not the distribution. Nothing about the forward pass
makes that point likely; it is simply the arithmetic consequence of the numbers
you fed it.

**`monte_carlo()` returns the distribution that date sits in.** Sampling each
task's duration and re-running the network thousands of times produces the
range of finishes the plan can actually deliver:

| Percentile | Reading | Use it for |
|------------|---------|------------|
| `p50` | Half the simulated runs finished on or before this date. In practice it lands close to the CPM finish. | A midpoint, never a commitment |
| `p80` | 4 in 5 runs finished by this date. | **The commitment date** — internal and stakeholder plans |
| `p95` | 19 in 20 runs finished by this date. | Contractual deadlines, launch dates, regulatory submissions |

So a CPM finish of `2026-03-03` and a P80 of `2026-03-14` do not disagree. They
say: *the plan can finish on March 3, and it will finish by March 14 four times
out of five.* Committing to March 3 is committing to a coin flip.

Two consequences worth internalizing:

- **A task with no three-point estimate contributes no uncertainty.** It uses
  its fixed `duration` on every run, so a project where nothing is estimated
  simulates to precisely the CPM finish — `p50 == p80 == p95`. That is a correct
  result, not a broken one: you asked what varies, and the answer was nothing.
  Add optimistic/most-likely/pessimistic values to the tasks that drive the date
  (`MonteCarloResult.sensitivity` ranks them) to get a real band.
- **Widening the band is not pessimism.** A pessimistic estimate set to
  `most_likely × 1.2` produces a distribution too narrow to be useful — PERT
  derives σ as `(P − O) / 6`, so a P barely above M encodes near-certainty. The
  P value should describe a realistic bad day.

The same framing, with the underlying math, is in
[the Monte Carlo documentation](https://docs.trueppm.com/features/monte-carlo/#interpreting-results).

> **Scope.** Only this package's Python engine runs Monte Carlo. The companion
> Rust/WASM engine (`trueppm-wasm-scheduler`, used for browser-side and offline
> recompute) implements the deterministic CPM pass only — there is no
> probabilistic path there to keep in conformance.
>
> Both engines are tested against each other and, separately, against an
> independent reference CPM written from the conventions below. The fields that
> comparison covers exactly, and the ones it does not, are listed in
> [CONTRIBUTING.md](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/CONTRIBUTING.md#the-independent-cpm-oracle).

## Conventions

Every modeling rule the engine commits to, one line each, with the issue or ADR
that decided it. **Differs** marks the rules where a schedule built in MS Project
or Primavera P6 can come out differently here; everything else follows their
convention. The same list, with the comparison spelled out, is on
[Scheduler Conventions](https://docs.trueppm.com/features/scheduler-conventions/).

**Units and calendars**

- Durations and three-point estimates count **working days**, in **whole days only**; a sub-day duration or lag raises `InvalidScheduleInput`. **Differs** — both tools schedule in hours. ([#826](https://gitlab.com/trueppm/trueppm/-/issues/826))
- `Calendar.hours_per_day` and `Calendar.timezone` are **inert** — they round-trip and change no date. **Differs.** ([#4131](https://gitlab.com/trueppm/trueppm/-/issues/4131))
- Lag counts **calendar days**; the resulting date always snaps **forward** to the successor's next working day — a lead (negative lag) follows the same rule and never snaps backward. **Differs** — MS Project and P6 count lag in working time by default. ([#2534](https://gitlab.com/trueppm/trueppm/-/issues/2534); open question [#2535](https://gitlab.com/trueppm/trueppm/-/issues/2535))
- Per-task calendars: duration expands on the task's own calendar, lag is consumed on the successor's. ([ADR-0120](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0120-cross-project-dependencies-within-program.md))

**Links and constraints**

- An **FF/SF**-driven task stays contiguous and right-aligned on its pinned finish, so its start moves back — the MS Project convention. Consequence: CPM is non-monotone in duration on an FF/SF network (a longer task can start earlier). ([#3806](https://gitlab.com/trueppm/trueppm/-/issues/3806), decided: keep)
- A zero-lag **FF** and a zero-lag **SS** on a whole-day Standard calendar reproduce the Start/Finish MS Project itself computed and saved for the same tasks — confirmed against a real MS Project export (`LinkTypes.mpp`), not just the documented rule. ([#4323](https://gitlab.com/trueppm/trueppm/-/issues/4323))
- An **SF** link finishes the successor at the start of the predecessor's start day — with zero lag, its last working day is the day before. A positive lag counts from the predecessor's start itself, so a weekend just before it cannot absorb the lag (a Monday start with `SF+2d` finishes the successor Tuesday); a lead counts back from the zero-lag finish. **Verified** for the zero-lag, ordinary-work case against a real MS-Project-saved schedule (`tests/fixtures/msproject/link_types_2013.py`, whose SF predecessor starts on a Tuesday), and now for a positive lag against four independently-corroborated MS-Project-saved alignments (`tests/fixtures/msproject/task_links_cross_version.py`, [#4327](https://gitlab.com/trueppm/trueppm/-/issues/4327)) — including the Monday-start, weekend-adjacent-anchor case [#4333](https://gitlab.com/trueppm/trueppm/-/issues/4333) reports: all four agree with MS Project, confirming the #4333 fix against external file evidence rather than only the hand-built regression test in `tests/test_sf_from_work.py`. **A second, separate divergence remains** ([#2534](https://gitlab.com/trueppm/trueppm/-/issues/2534)): the engine counts lag in **calendar** days and snaps forward once, so a lag long enough to reach a *second* weekend from the anchor again finishes one working day short of MS Project — confirmed on all four alignments by raising their lag past what the saved files actually used (e.g. the Monday-start case agrees through lag=6 and diverges again at lag=7; a mid-week start diverges as early as lag=3). An SF link out of a milestone remains unverified — no MS Project sample found covers it (#4327). ([#4145](https://gitlab.com/trueppm/trueppm/-/issues/4145), [#4322](https://gitlab.com/trueppm/trueppm/-/issues/4322), [#4333](https://gitlab.com/trueppm/trueppm/-/issues/4333), [#2534](https://gitlab.com/trueppm/trueppm/-/issues/2534))
- A task with an **SF link** may be placed before the project start: its project-start floor is the earlier of the project start and its SF placement, which its SF links already enforce, so the project start never holds it back, and a binding FS, SS or FF lead can also place it there. A task with no SF link keeps the floor, so its leads stay floored. A data date or `planned_start` after the project start, and a recorded `actual_start`, hold every task. A shorter lag never finishes work later; on a network of tasks with work, an FS, SS or FF link that does not bind moves nothing. MS Project's behavior for mixed links and for leads is **unverified** ([#4319](https://gitlab.com/trueppm/trueppm/-/issues/4319)). ([#4218](https://gitlab.com/trueppm/trueppm/-/issues/4218), [#4220](https://gitlab.com/trueppm/trueppm/-/issues/4220))
- **A data date at or before the project start moves nothing, and neither does such a `planned_start` (SNET) on a task with no SF link.** Snapped to the task's calendar, a bound on or before the project's first working day is the project-start floor, so the engine treats it as that floor: every task that takes the project start already has it, and the places that leave it out (an SF-linked task, and the instant a milestone's successors measure their lags from, both below) do not get it back through it. So adding `status_date <= start_date` changes no task's dates, floats or the finish, a `null` status date schedules exactly like one on the start, and an SNET on or before the start changes nothing on a task with no SF link. This matters because callers often default the data date to today: on a project that starts in the future that is a date before the start, and it used to pull a free milestone's successors up to (start − today) days earlier. The data-date half applies to SF-linked tasks too, which is a decision, not a consequence: a sub-start data date could hold an SF-linked task that its link places even earlier, and it no longer does. An SNET on an SF-linked task is kept verbatim, even before the start: such a task takes no project-start floor, so the SNET can only hold it later than its links place it, and snapping a task to the project start (or moving the start to it) writes exactly that SNET. A recorded `actual_start` is kept verbatim, because a fact may precede the plan. A data date or SNET after the start binds as before. ([#4635](https://gitlab.com/trueppm/trueppm/-/issues/4635))
- A zero-duration **milestone** is an instant: at the end of its driver's finish day, or the start of the day a floor holds it to. A lag, or a predecessor's recorded finish on a non-working day, that places it after a weekend or holiday shows it at the start of the next working day — confirmed for the work-driven case against a real MS Project export with all 10 zero-duration milestones in a saved `.mpp` chain. The project start only bounds the day a milestone is shown on: a milestone that a lead or an SF-placed predecessor puts before it is shown on the project's first working day (unless it has an SF link of its own), but its successors' lags count from the earlier point — **unverified** against MS Project or P6 ([#4225](https://gitlab.com/trueppm/trueppm/-/issues/4225)). Its start and finish are one instant, so an FF link into a milestone places it exactly where FS does, a lagged SF link places it on its anchor plus the lag (a positive lag counts from the predecessor's start itself), and an FF link out of it measures a positive lag from that instant; with no lag or a lead it counts from the end of the working day before the milestone, so a longer lead never finishes the successor later. ([#4079](https://gitlab.com/trueppm/trueppm/-/issues/4079), [#4173](https://gitlab.com/trueppm/trueppm/-/issues/4173), [#4225](https://gitlab.com/trueppm/trueppm/-/issues/4225), [#4272](https://gitlab.com/trueppm/trueppm/-/issues/4272), [#4273](https://gitlab.com/trueppm/trueppm/-/issues/4273), [#4323](https://gitlab.com/trueppm/trueppm/-/issues/4323))
- The **only** date constraint is start-no-earlier-than, via `planned_start`; `planned_finish` is reserved and inert — no deadline, finish, must-start-on or ALAP constraint. **Differs.** ([#3345](https://gitlab.com/trueppm/trueppm/-/issues/3345), [#804](https://gitlab.com/trueppm/trueppm/-/issues/804))
- An **SS or SF link from a summary task** is rejected (FS/FF from a summary expand to its leaves). **Differs** — MS Project accepts it. ([ADR-0370](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0370-reject-ss-sf-from-summary-tasks.md))

**Progress and actuals**

- A **completed** task (`actual_finish` set, or 100%) is pinned to its recorded dates verbatim — even on a non-working day — and is never re-sampled. With no recorded actuals it is pinned at the project start (or its `planned_start`, when later); no predecessor moves it. A completed milestone stays an instant: with no actuals at the start of its pinned day; with actuals on its recorded `actual_finish` (else `actual_start`) day, at the edge of that day it had live — the end when completed work finishing that day placed it, or — while a predecessor is still open — when `Task.live_day_end_on` (the day your previous run showed it at the end of) names that day; otherwise the start. No change to open work moves it, and when you pass your previous run's output back, closing it on its forecast day moves no successor ([#4433](https://gitlab.com/trueppm/trueppm/-/issues/4433), [#4525](https://gitlab.com/trueppm/trueppm/-/issues/4525)). ([ADR-0136](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0136-completed-task-full-duration-span.md))
- An **in-progress** task schedules its remaining `duration − floor(duration × pct / 100)` working days forward from the data date (`status_date`), floored at its unsnapped `actual_start`. ([ADR-0132](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0132-data-date-aware-progress-forecasting.md))

**Float and output**

- `is_critical` is exactly `total_float == 0`; total float is the working days from early to late start.
- `free_float` inverts the forward constraint across **all four** link types, capped at total float; no live successor → total float. ([#1828](https://gitlab.com/trueppm/trueppm/-/issues/1828))
- The order of `ScheduleResult.tasks` is **unspecified** — look tasks up by `id`. ([#1862](https://gitlab.com/trueppm/trueppm/-/issues/1862))
- `project_finish` and a milestone's `early_finish` are the **day the finish is shown on**, and `milestone_at_day_end` says which edge of it. The end of a Friday and the start of the next Monday are the same point in working time, so the shown day can hop a weekend or holiday with no working-time move. **Compute slip in working time**, reading a start-of-day milestone finish as the end of the working day before it — never as a calendar-day difference of two finishes. ([#4178](https://gitlab.com/trueppm/trueppm/-/issues/4178))
- The same holds for Monte Carlo: `MonteCarloResult.p50`/`p80`/`p95` are shown days, and `p50_at_day_start`/`p80_at_day_start`/`p95_at_day_start` say which edge of each. Compare a percentile with the CPM finish, or with another run's percentile, in working time. ([#4204](https://gitlab.com/trueppm/trueppm/-/issues/4204)) These are read-only properties over `MonteCarloResult.percentiles`, a `dict[int, Percentile]` of the levels that were computed (`Percentile(date, at_day_start)`), so `result.percentiles[80].date` equals `result.p80`. ([#4514](https://gitlab.com/trueppm/trueppm/-/issues/4514))

**Monte Carlo**

- Three-point estimates sample a Beta **fitted by method of moments to the classic PERT mean `(O + 4M + P) / 6` and σ = `(P − O) / 6`** — not the λ=4 Beta-PERT. Same mean; on a symmetric estimate the band is ~12% narrower (P80/P95 slightly earlier), on one whose mode sits at an end it is wider. **Differs** from @RISK's default. ([ADR-1245](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/1245-pert-sampler-moment-fit-convention.md), [#4133](https://gitlab.com/trueppm/trueppm/-/issues/4133))
- Every sampled duration is **floored at `Task.duration`** — the optimistic tail below the plan is not expressed. **Differs** — risk tools sample the whole estimate. ([#3765](https://gitlab.com/trueppm/trueppm/-/issues/3765))
- "Never before the CPM finish" holds **only on FS/SS-only networks**; on an FF/SF network a percentile can land earlier, because CPM itself is non-monotone there. ([#3806](https://gitlab.com/trueppm/trueppm/-/issues/3806))
- A fixed `seed` reproduces P50/P80/P95 on the **same numpy and `trueppm-scheduler` versions** — see [Reproducibility](#reproducibility-seeded-runs). ([#4099](https://gitlab.com/trueppm/trueppm/-/issues/4099))

## Errors and input limits

Every exception the engine *documents* raising subclasses `ValueError` (via the
common `SchedulerError` base), so one `except ValueError` catches them all — but
each is individually catchable:

| Exception | Raised when |
|-----------|-------------|
| `CyclicDependencyError` | The dependency graph contains a cycle. `.cycle` lists the task IDs forming it. |
| `SimulationCapExceeded` | `monte_carlo(runs=…)` exceeds `max_runs`, or the project has more tasks than `max_tasks`. |
| `InvalidScheduleInput` | The input is structurally valid but out of range, or the wrong type (see below). |
| `UnknownTaskError` | `derive_value(project, task_id, …)` is called with a `task_id` that names no task in the project. |

**What this guarantee actually covers.** `Project.from_dict()` / `Project.from_json()`
— the untrusted-input path — type-check and coerce every field, so a malformed
document of *any* shape raises `InvalidScheduleInput` and never a bare
AttributeError/TypeError. Constructing `Project`/`Task`/`Dependency` directly in
Python (the **direct-object API**, as in every example above) is held to the same
field rules `from_dict()` applies, on every field of `Project`, `Task`,
`Dependency` and `Calendar` — including the fields the engine never reads: the
reserved `Calendar.hours_per_day` (a finite number) and `timezone` (a string), the
computed task dates (`early_start` … `scheduled_start`, plain `date` or `None`)
and floats (`total_float`/`free_float`, `timedelta`), the `is_critical` and
`milestone_at_day_end` flags (`bool`), and `delivery_mode` (a `DeliveryMode` or
`None`, not the string `"scrum"`). `Calendar.working_days` must be an integer in
`[0, 127]`, and a `calendars` registry must be keyed by string ids. A wrong-typed
or out-of-range value (`None`, a string, a `datetime`, a bare int where a list or
`timedelta` is expected, an unhashable value, …) makes `schedule()` and
`monte_carlo()` raise `InvalidScheduleInput`, not a bare Python exception.
(`derive_value()` applies the same check when it schedules the project itself,
i.e. when called without `result=`.)

So any project `schedule()` accepts round-trips: `Project.from_json(p.to_json())`
loads it back unchanged and schedules it identically. `to_dict()` and `to_json()`
on `Project` (and `to_dict()` on `Task`, `Dependency` and `Calendar`) apply the
same rules and raise `InvalidScheduleInput` for a field they cannot serialize.
Construction itself stays lenient — the check runs when a project is scheduled or
serialized, so an object can be built partially and filled in first.
`tests/test_exception_contract.py` pins the per-field guarantee with a
single-field-mutation sweep over the init fields × 12 adversarial values × both
`schedule()`/`monte_carlo()` entry points (`Task.id` is excluded from that sweep;
a non-string task id is covered by the explicit examples in
`tests/test_contract_fuzz.py`), and `tests/test_roundtrip_contract.py`
property-tests the round trip, so a future field addition that reopens a gap fails
a test rather than becoming a silent leak.

The engine walks the working calendar one day at a time, so it also validates
input up front rather than spinning on a degenerate project:

- **Calendar** — `working_days` must be an integer bitmask in `[0, 127]` that sets
  at least one weekday bit (Mon–Sun); a
  calendar whose `exceptions` blanket the entire search window is rejected too.
- **Duration** — each task duration must be between `0` and `MAX_DURATION_DAYS`
  (`36_525`, ~100 years). Negative durations are rejected.
- **Lag** — each dependency lag must be within `±MAX_LAG_DAYS` (`36_525`).
- **Project span** — the cumulative span (every task's worst-case duration plus
  the magnitude of every lag) must stay under `MAX_PROJECT_SPAN_DAYS`
  (`366_000`, ~1000 years), regardless of task count.
- **Monte Carlo** — `runs` must be `>= 1`.

`Project.from_json()` also rejects the non-standard JSON literals `NaN`,
`Infinity`, and `-Infinity`.

```python
from trueppm_scheduler import schedule, InvalidScheduleInput

try:
    result = schedule(project)
except InvalidScheduleInput as e:
    print("Bad input:", e)  # "Task 't-1' duration exceeds the maximum of 36525 days (got …)."
```

### Limits for embedders

The validator caps above are all exported from the top-level `trueppm_scheduler`
package, under the same names the error messages use, so an embedding
application can check or re-enforce them without hand-copying a number:

| Cap | Value | Bounds |
|-----|-------|--------|
| `MAX_DURATION_DAYS` | `36525` | A single task's duration or PERT estimate (~100 years) |
| `MAX_LAG_DAYS` | `36525` | A single dependency's lag, either direction |
| `MAX_PROJECT_SPAN_DAYS` | `366000` | Cumulative project span — every task's worst-case duration plus every lag (~1000 years) |
| `MAX_DEPENDENCIES` | `100000` | Raw dependency-edge count, before summary expansion |
| `MAX_EXPANDED_EDGES` | `100000` | Leaf-level edges after expanding a summary↔summary dependency |
| `MAX_CALENDAR_EXCEPTIONS` | `100000` | Exception ranges on one `Calendar` |
| `MAX_CALENDAR_SCAN_DAYS` | `36600` | Longest run of consecutive non-working days before a calendar is declared degenerate |
| `MAX_LAG_DELTA_CELLS` | `50000000` | Monte Carlo's `(distinct dep-type/lag combos) x (index span)` precompute |
| `MAX_VELOCITY_SPRINTS` | `10000` | Per-run sprint horizon the velocity sampler will bootstrap |
| `MC_SENSITIVITY_CAP` | `20` | Tasks returned by the sensitivity ("tornado") ranking |

```python
from trueppm_scheduler import MAX_DEPENDENCIES, MAX_DURATION_DAYS, MAX_LAG_DAYS
```

There is no fixed task-count or run-count cap built into the engine itself —
`monte_carlo(max_runs=…, max_tasks=…)` are opt-in, caller-supplied ceilings that
default to `None` (uncapped). That default is correct for a batch script or
notebook that owns the whole machine, and wrong for a synchronous web request:
**`schedule()` and `monte_carlo()` are CPU-bound** (a day-by-day calendar walk,
plus a numpy-vectorized sampling pass), so a request handler that calls either
directly on untrusted or unbounded input ties up a worker thread or process for
as long as the input demands. Pass `max_runs` and `max_tasks` whenever the
caller is untrusted, and run the call off the request thread with a wall-clock
timeout — a worker/queue, not inline in the view — the same pattern the
TruePPM API itself uses
([#4010](https://gitlab.com/trueppm/trueppm/-/issues/4010)).

A long calendar exception does not cost more as the dependency graph grows:
calendar-day lookups are index-backed (a cached, bisected merged-interval
index), so both the CPM pass and Monte Carlo snap to the next or previous
working day in `O(log E)` regardless of how many tasks or dependencies
reference that calendar.

## API stability and versioning

**The public API is the `__all__` surface of the top-level `trueppm_scheduler`
package** — the names you can import directly from `trueppm_scheduler`
(`schedule`, `monte_carlo`, `Project`, `Task`, `Dependency`, `DependencyType`,
`Calendar`, `ScheduleResult`, `MonteCarloResult`, the exception types, etc.).
Everything else — the `trueppm_scheduler.engine` internals, any underscore-
prefixed helper, and module layout — is **unstable** and may move or change
without notice.

This package is **`Development Status :: 4 - Beta`** as of 0.4.0b1: the public
API may still change before 1.0. **Pin an exact version** rather than a range:

```
trueppm-scheduler==0.4.0rc2
```

Beta releases are pre-releases: `pip` installs a pre-release only when you pass
`--pre`, **or when no final release satisfies the requirement yet**. PyPI
currently holds only pre-releases of `trueppm-scheduler` (no version has
reached final), so today a bare `pip install trueppm-scheduler` falls into the
second case and installs the latest beta. Once `0.4.0` final ships, that
changes: a bare install will resolve to `0.4.0` and skip any later `0.5.0`
betas unless you pass `--pre` — which is why pinning an exact version (above)
is the reliable approach in either state. Breaking changes are recorded in
[`CHANGELOG.md`](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/CHANGELOG.md),
which also ships inside the wheel.

### Heads-up: `trueppm_scheduler.engine` becomes a subpackage in 0.5

0.5 will split the single `trueppm_scheduler/engine.py` module into an
`engine/` subpackage (CPM, Monte Carlo, calendar math, validation, and so on in
separate files). The split is planned to land on `main` in November–December
2026 and ship with 0.5
([#4550](https://gitlab.com/trueppm/trueppm/-/issues/4550)). It is a pure move:
scheduling results will not change.

**Will keep working, unchanged:**

- Every import from the top-level `trueppm_scheduler` package (the `__all__`
  surface above).
- `from trueppm_scheduler.engine import X` for every name importable today,
  including underscore-prefixed helpers. `engine/__init__.py` re-exports them
  for the whole 0.5 line.
- Result objects pickled by 0.4 will still unpickle on 0.5.

**Will need a change on your side:**

- **Patching engine internals in your tests.**
  `unittest.mock.patch("trueppm_scheduler.engine._helper")` or
  `monkeypatch.setattr(engine, "MAX_DEPENDENCIES", 1)` will replace the
  re-exported name. The code that actually calls the helper or reads the
  constant will still see the original, so the patch stops taking effect,
  usually without failing the test. Point such patches at the submodule that
  defines the name once you upgrade.
- Code that reads a class's `__module__`, or tooling keyed on the file path
  `trueppm_scheduler/engine.py` (coverage or lint excludes, for example).
- Result objects pickled by 0.5 will not unpickle on 0.4.

If you depend only on the public API, there is nothing to do.

### Reproducibility (seeded runs)

Monte Carlo simulation is **reproducible for a fixed seed**: the same `seed`
always yields the same P50/P80/P95 forecast for the same input, **on the same
numpy version and the same `trueppm-scheduler` version**. Within that envelope
this is a supported, tested property you can rely on for reproducible reports
and regression baselines — not an implementation detail.

Outside it, it is not promised. The dependency range is `numpy>=1.26,<3`, and
numpy guarantees a `Generator`'s random stream (`Generator.beta` included) only
within one release ([NEP 19](https://numpy.org/neps/nep-0019-rng-policy.html)),
so upgrading numpy can move seeded percentiles. A `trueppm-scheduler` release
can move them too — a sampling fix or a change to the order tasks are sampled
in is recorded in the changelog. If a seeded baseline must stay bit-identical,
pin both packages alongside the seed.

This is a statement about *repeatability of the sampling*, not about the shape
of the answer — a seeded Monte Carlo run still returns a probability
distribution. Do not confuse it with the deterministic single-date output of
`schedule()`, which is [a different thing entirely](#interpreting-the-output).

## Status and roadmap

**0.4 — the current release.** The CPM pass (all four dependency types,
calendar-aware lag, cycle detection) and Monte Carlo simulation (PERT-Beta,
velocity sampling, `derive_value()` explainability) are stable and exercised
by the fuzz, mutation, and MS-Project-parity suites described in
[CONTRIBUTING.md](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/CONTRIBUTING.md).

**Known limitations open against 0.4**, grouped by area — every item below is
an open issue; nothing in this list is fixed yet, regardless of which future
release it is scheduled for:

- **CPM correctness** — while any predecessor of a closed milestone is still
  open, its frozen day edge (`live_day_end_on`) reflects the last derivation,
  so correcting a completed predecessor's actuals or removing a link is not
  re-read until every predecessor completes
  ([#4574](https://gitlab.com/trueppm/trueppm/-/issues/4574)); a work-task
  late-finish seed can ignore a
  start-of-day project finish on wider calendars
  ([#4436](https://gitlab.com/trueppm/trueppm/-/issues/4436)); FF/SF links
  *into* a summary task do not fan out to every leaf the way the successor
  side does
  ([#4437](https://gitlab.com/trueppm/trueppm/-/issues/4437)); `perturb_task_duration(duration=0)`
  on a started milestone can mark it complete and move the schedule as a side
  effect of the perturbation
  ([#4536](https://gitlab.com/trueppm/trueppm/-/issues/4536)); `driving_edges`
  can omit a link whose calendar-day lag lands on non-working time even
  though removing it does move the successor
  ([#4537](https://gitlab.com/trueppm/trueppm/-/issues/4537));
  `expand_summary_dependencies` can invent a sibling ordering from a
  summary-to-own-child link that `find_cycle` correctly flags as a cycle
  ([#4538](https://gitlab.com/trueppm/trueppm/-/issues/4538)); a completed
  task with no recorded actuals can be moved later than the data date, a
  non-monotonicity where knowing less about a task slips the schedule
  further than knowing more
  ([#4539](https://gitlab.com/trueppm/trueppm/-/issues/4539)); and several
  MS-Project-parity cases — SF out of a milestone, mixed SF+FS/SS/FF at the
  project-start floor — remain unverified against a real MS Project export
  ([#4327](https://gitlab.com/trueppm/trueppm/-/issues/4327),
  [#4319](https://gitlab.com/trueppm/trueppm/-/issues/4319)).
- **Monte Carlo** — a velocity-sampled duration is re-expanded
  against the task's own calendar rather than the sprint calendar it was
  sampled against
  ([#4529](https://gitlab.com/trueppm/trueppm/-/issues/4529)); sprint-horizon
  clamping truncates the slow tail of a velocity-driven P80/P95, so it reads
  as a lower bound rather than a full forecast
  ([#2469](https://gitlab.com/trueppm/trueppm/-/issues/2469)); three
  `monte_carlo()` keyword caps still leak a bare `TypeError` instead of the
  documented `SchedulerError` contract
  ([#4464](https://gitlab.com/trueppm/trueppm/-/issues/4464)); and percentile
  estimation is imprecise at very low run counts (10–11 runs), where the
  reported P95 can have only 90% of runs on or before it
  ([#4540](https://gitlab.com/trueppm/trueppm/-/issues/4540)).
- **Calendars** — a zero-lag milestone-to-milestone link into a narrower
  per-task calendar can overstate float
  ([#4526](https://gitlab.com/trueppm/trueppm/-/issues/4526)).
- **Scale / performance** — a project above roughly 73,000 tasks at a 5-day
  average duration is refused as "longer than 1,000 years" by a span guard
  meant to catch pathological input, not real large projects
  ([#3830](https://gitlab.com/trueppm/trueppm/-/issues/3830)); Monte Carlo
  holds three `(runs × tasks)` float64 matrices live in memory, already 2.3 GB
  at 50,000 tasks
  ([#3824](https://gitlab.com/trueppm/trueppm/-/issues/3824)).
- **API contract / errors** — the derivation vocabulary
  (`DerivationContribution.kind`, `Derivation.quantity`/`pass_`) is still an
  open string, not a published enum
  ([#4291](https://gitlab.com/trueppm/trueppm/-/issues/4291)), and exported
  dataclasses document their fields in source comments rather than
  Google-style `Attributes:` sections, so they do not render in a generated
  API reference
  ([#4471](https://gitlab.com/trueppm/trueppm/-/issues/4471)).
- **WASM engine** — `wasm-scheduler` errors are untyped strings at 17 call
  sites rather than a structured error type
  ([#4474](https://gitlab.com/trueppm/trueppm/-/issues/4474)), and the CPM
  invariant-property suite that fuzzes the Python engine has no Rust port
  yet, so a Rust-only regression would not be caught the same way
  ([#4270](https://gitlab.com/trueppm/trueppm/-/issues/4270)).

**Committed for 0.5.** 0.5 will run a hardening pass over the engine
([#3988](https://gitlab.com/trueppm/trueppm/-/issues/3988)) rather than ship
new scheduling features; the following are `release::committed` for 0.5 —
they will ship with 0.5 or that release will slip:

- **Engine decomposition and correctness hardening** — splitting `engine.py`
  into a subpackage without breaking imports (see the
  [heads-up](#heads-up-trueppm_schedulerengine-becomes-a-subpackage-in-05) above;
  [#4550](https://gitlab.com/trueppm/trueppm/-/issues/4550)) and extending the
  independent CPM oracle to milestone late dates/floats
  ([#4275](https://gitlab.com/trueppm/trueppm/-/issues/4275)); mutation-testing
  phase 2 brings `engine.py` itself into scope
  ([#2468](https://gitlab.com/trueppm/trueppm/-/issues/2468)); three more bare-exception leaks close the
  `SchedulerError` contract
  ([#4162](https://gitlab.com/trueppm/trueppm/-/issues/4162),
  [#4132](https://gitlab.com/trueppm/trueppm/-/issues/4132)); and the span-guard
  bug above will be fixed, raising the supported envelope toward 50,000 tasks
  ([#3830](https://gitlab.com/trueppm/trueppm/-/issues/3830),
  [#3825](https://gitlab.com/trueppm/trueppm/-/issues/3825)).
- **Performance** — a published `pytest-benchmark` suite at 100–5,000 tasks,
  with measured numbers in this README
  ([#4230](https://gitlab.com/trueppm/trueppm/-/issues/4230)); the Monte Carlo
  memory footprint above is chunked over runs and dropped to float32
  ([#3824](https://gitlab.com/trueppm/trueppm/-/issues/3824)); the CPM
  duration-expansion day-walk above moves off O(duration)
  ([#1531](https://gitlab.com/trueppm/trueppm/-/issues/1531)).
- **Monte Carlo correctness** — the sprint-horizon clamp bug above will be
  fixed ([#2469](https://gitlab.com/trueppm/trueppm/-/issues/2469)); an
  in-progress task's sampled duration no longer has its optimistic tail
  truncated by subtracting deterministic elapsed time from the sampled total
  ([#1495](https://gitlab.com/trueppm/trueppm/-/issues/1495)).
- **Scheduling semantics** — the calendar-day-vs-working-day lag question will be
  decided ([#2535](https://gitlab.com/trueppm/trueppm/-/issues/2535));
  deadline-driven negative float will surface "behind committed date" in CPM
  output ([#804](https://gitlab.com/trueppm/trueppm/-/issues/804)); and
  partial resource allocation (e.g. someone at 60%) will be enforced in the
  CPM/leveling pass
  ([#84](https://gitlab.com/trueppm/trueppm/-/issues/84),
  [#744](https://gitlab.com/trueppm/trueppm/-/issues/744)).
- **Packaging** — stale/placeholder `CITATION.cff` metadata (a fake ORCID and
  DOI) will be corrected
  ([#3857](https://gitlab.com/trueppm/trueppm/-/issues/3857)).

May also land in 0.5, but not committed: the velocity-sampled duration
re-expansion on the wrong calendar above
([#4529](https://gitlab.com/trueppm/trueppm/-/issues/4529)), the
FF/SF-into-summary fan-out and `derive_value()` binding/`imposed_date`
mismatch above
([#4437](https://gitlab.com/trueppm/trueppm/-/issues/4437),
[#4438](https://gitlab.com/trueppm/trueppm/-/issues/4438)), the remaining
MS-Project-parity gaps, the zero-lag milestone-calendar overstatement
([#4526](https://gitlab.com/trueppm/trueppm/-/issues/4526)), the three leaking
Monte Carlo keyword caps, a `monte_carlo(return_samples=True)` option to
hand back the raw matrices
([#4166](https://gitlab.com/trueppm/trueppm/-/issues/4166)), and five findings
from the 2026-10-18 scheduler audit above: the `perturb_task_duration`
milestone side effect
([#4536](https://gitlab.com/trueppm/trueppm/-/issues/4536)), the
`driving_edges` false negative on calendar-lag-onto-non-working-time
([#4537](https://gitlab.com/trueppm/trueppm/-/issues/4537)), the
`expand_summary_dependencies` sibling-ordering bug on invalid input
([#4538](https://gitlab.com/trueppm/trueppm/-/issues/4538)), the
completed-task-without-actuals non-monotonicity
([#4539](https://gitlab.com/trueppm/trueppm/-/issues/4539)), and Monte Carlo
percentile imprecision at very low run counts
([#4540](https://gitlab.com/trueppm/trueppm/-/issues/4540)).

**Later — a sequence, not a schedule.** Versions past 0.5 carry no date; what
ships and in what order is set by evidence from the 0.4 beta and 0.5, not by
this list (full rationale on the
[roadmap](https://docs.trueppm.com/overview/roadmap/)). 0.6 will open the write
surface safely — an engine-as-referee that will refuse any agent write which
would create an impossible schedule, building on the 0.5 plan-mode dry run —
and will start the hybrid human/AI engine depth begun in 0.5: sub-day scheduling,
an explicit effort-vs-duration split, and a probabilistic human-fallback
branch for agent-delivered work. 0.6 is also planned to bring the OSS resource-leveling
pass: CPM assumes infinite resources today, and leveling will resolve the
conflicts the 0.5 pre-commit warning only flags. 0.7 is planned to bring
resource-constrained Monte Carlo once the sampler's own correctness checks are
in place, Rust/WASM leveling parity, and probabilistic branching (conditional
paths sampled per run). 0.8 is planned to add task splitting (interruptible,
resumable duration).

## Security

Found a vulnerability in the scheduling engine? Please report it privately —
do **not** open a public issue. Email **security@trueppm.com** or open a
confidential GitLab issue. Full policy, response SLAs, and safe-harbor terms are
in [`SECURITY.md`](https://gitlab.com/trueppm/trueppm/-/blob/main/SECURITY.md)
at the monorepo root.

## License

Apache 2.0
