# trueppm-scheduler

[![PyPI version](https://img.shields.io/pypi/v/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-scheduler.svg)](https://pypi.org/project/trueppm-scheduler/)
[![CI](https://gitlab.com/trueppm/trueppm/badges/main/pipeline.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

**Project-schedule math as a library — critical path and delivery-risk forecasting, without a 500 MB desktop app or a SaaS subscription.**

Answer the two questions every plan has to answer:

- **"What's the earliest this can finish, and which tasks can't slip?"** — a full forward/backward critical-path pass computes early/late dates, total and free float, and flags the tasks on the critical path.
- **"How confident are we in that date?"** — Monte Carlo simulation turns three-point estimates into a P50/P80/P95 forecast, so you can commit to a date you'll actually hit instead of the best-case one.

It's pure Python with just `numpy` underneath — no Django, no web server, no GUI. Drop it into a backend, a data pipeline, a Jupyter notebook, or a CLI and get the same engine that powers the [TruePPM](https://trueppm.com) platform.

### Why reach for this

- **Real scheduling semantics, not a toy.** All four dependency types (finish-to-start, start-to-start, finish-to-finish, start-to-finish) with lead/lag on every link — most lightweight schedulers only do finish-to-start, which cannot express an overlap or a wait without faking it with a dummy task.
- **Working-time aware.** A built-in working-day calendar skips weekends and honors holiday exceptions, so durations resolve to real delivery dates.
- **Risk forecasting built in.** PERT-Beta Monte Carlo (a Beta moment-fitted to the classic PERT mean and σ = (P − O)/6 — see [Conventions](#conventions)), numpy-vectorized (10,000 runs on a 200-task project take roughly 60–100 ms on a current laptop CPU) — the difference between "due March 3" and "70% likely by March 3, 95% by March 14."
- **Fails loud on bad input.** Cycle detection that names the offending task IDs, plus up-front validation of durations, lag, and project span — no silent wrong answers, no spinning on a degenerate graph.
- **Embeds anywhere.** Two dependencies, no framework. Serialize a plan to JSON, schedule it, and read back structured results.

## Features

- Forward/backward CPM pass with all four dependency types (FS, SS, FF, SF), total/free float, and critical-path flagging
- Calendar-aware working-day arithmetic (weekend skip + holiday exceptions), with optional per-task calendars for mixed-team schedules
- Monte Carlo schedule-risk simulation via PERT-Beta distributions — method-of-moments fit to the classic PERT mean and σ = (P − O)/6, not the λ=4 Beta-PERT (numpy-vectorized: roughly 60–100 ms per 10,000 runs on a 200-task project) → P50/P80/P95 completion dates
- Hybrid agile/waterfall forecasting (**experimental** from 0.5, see [Mixing agile and waterfall](#mixing-agile-and-waterfall-in-one-schedule)) — mark a task `delivery_mode=SCRUM` with a `story_points` estimate and Monte Carlo samples its duration from the team's own velocity history instead of a per-task PERT guess, so a project can mix sprint-delivered and traditionally-estimated work in one simulation
- Explainable results — `derive_value()` answers "why is this date what it is?" for any early/late/float value, naming the exact predecessor, dependency type, and lag that won, plus every constraint it beat
- JSON round-tripping for plans (`Project.from_json()` / `Project.to_json()`)
- CLI: `trueppm-scheduler schedule` / `trueppm-scheduler monte-carlo`. From 0.5, human-readable output will escape control, bidi, and zero-width characters in project strings; `--json` output is JSON-escaped.

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

### Holidays and other non-working dates

A holiday, shutdown or any other run of non-working dates is a `DateRange`. Pass
them as `Calendar.exceptions`. Both ends are **inclusive**, and a single day is a
range whose `start` and `end` are the same date:

```python
from datetime import date, timedelta
from trueppm_scheduler import Calendar, DateRange, Project, Task, schedule

calendar = Calendar(
    exceptions=[
        DateRange(start=date(2026, 1, 6), end=date(2026, 1, 7)),  # Tue-Wed shutdown
        DateRange(start=date(2026, 1, 9), end=date(2026, 1, 9)),  # one day: Fri
    ]
)
project = Project(
    id="p-2",
    name="With holidays",
    start_date=date(2026, 1, 5),  # Monday
    tasks=[Task(id="t-1", name="Build", duration=timedelta(days=3))],
    calendar=calendar,
)
build = schedule(project).tasks[0]
print(build.early_finish)  # 2026-01-12 (Mon, Thu, then Mon: Jan 6-7 and 9 are skipped)
```

A `DateRange` is immutable. To change a calendar's holidays, build new ranges and
assign a new `Calendar.exceptions`. Both bounds must be plain `date`s (not
`datetime`s or strings), or `InvalidScheduleInput` is raised.

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

From 0.5, the vocabulary will be published as enums instead of open strings:
`ContributionKind` (`DerivationContribution.kind`), `Quantity` (`quantity`), `DerivationPass`
(`pass_`) and `DependencyType` (`dep_type`, here, on `DrivingEdge` and on `to_graph`'s
`GraphEdge`). All are
`StrEnum`s, so existing comparisons such as `binding.kind == "predecessor_fs"`
keep working, and `to_dict()` emits the same plain strings. A later release may
add a `ContributionKind`, so keep a default branch when you switch on it.

## Keeping the per-run samples

From 0.5, `monte_carlo(project, return_samples=True)` will also hand back the
matrices behind the percentiles, as a `MonteCarloSamples` on `result.samples`:

```python
from datetime import date
from trueppm_scheduler import monte_carlo

result = monte_carlo(project, runs=2_000, seed=42, return_samples=True)
samples = result.samples
column = samples.task_ids.index("t-2")
durations = samples.durations[:, column]  # float32 days, one per run
finishes = [date.fromordinal(int(x)) for x in samples.early_finish[:, column]]
```

Both matrices are `(runs, n_tasks)` and cost `runs x n_tasks x 4 bytes x 2`
(80 MB for 1,000 tasks x 10,000 runs) on top of the run itself. Above
50,000,000 cells the call raises `SimulationCapExceeded`; the default path is
unaffected.

## Milestone percentiles

From 0.5, `monte_carlo()` will take an opt-in `targets` argument. It defaults to
off, so a call without it returns what it does today at the same cost, and it
draws nothing from the random stream, so seeded P50/P80/P95 and the tornado
ranking do not move when you turn it on.

```python
result = monte_carlo(project, runs=10_000, seed=42, targets=["design-complete"])
design = result.targets["design-complete"]  # a TargetForecast
design.p80                                   # the P80 on that one milestone
design.percentiles[95].date                  # the same mapping, by level
```

`targets` names up to `MC_TARGET_CAP` (50) task ids. Each comes back on
`result.targets` as a `TargetForecast` (`task_id`, `percentiles`, `distribution`),
read from the same per-run finishes the project finish is the maximum of. So at
every level a target is never later than the project. Where a target's own reading
would be shown later than the project's (a start-of-day milestone on the Monday,
the project at the end of the Friday before it), it takes the project's, and that
level can then sit ahead of the target's own `distribution`. With mixed calendars
the day it takes can be one the target's own week does not work. A completed target
reports its recorded finish at every level. A task on its own calendar is read through its
own working week ([#4135](https://gitlab.com/trueppm/trueppm/-/issues/4135)).

`percentiles` is the extensible `dict[int, Percentile]` mapping, the same form as
`MonteCarloResult.percentiles` ([#4514](https://gitlab.com/trueppm/trueppm/-/issues/4514)),
so a further level is a key rather than a new field. `p50`, `p80` and `p95` are
convenience properties over it.

## Exporting the graph

> **Ships in 0.5.** `to_graph()` and the graph types below are not in 0.4.0; this
> section describes `main`.

From 0.5, `to_graph()` will flatten a schedule into plain nodes and edges (early/late dates,
total float, a critical flag, and each link's type, lag and `is_driving` flag)
that any renderer can draw. It is a pure read of the result: no new scheduling
math, no graph library, and the same schedule always serializes to the same JSON.

```python
from trueppm_scheduler import GraphExport, to_graph

graph = to_graph(result, project)          # result = schedule(project)
for n in graph.nodes:
    print(n.id, n.early_start, n.total_float_days, n.is_critical)
for e in graph.edges:
    print(e.predecessor_id, e.dep_type, e.successor_id, e.lag_days, e.is_driving)
assert GraphExport.from_json(graph.to_json()) == graph   # lossless round trip
```

`graph.nodes` holds `GraphNode` objects and `graph.edges` holds `GraphEdge` objects.
`GRAPH_FORMAT_VERSION` versions the dict/JSON shape; the key set (and the
three-field `DrivingEdge` that feeds `is_driving`) is frozen under it, and
`from_dict` refuses another version. A cyclic graph, an edge naming a task that
is not a node, or a result that does not match the project raises
(`CyclicDependencyError` or `InvalidScheduleInput`, naming the ids); a partial
graph is never returned.

A result "matches" when its project id and its task ids equal the project's and
every driving edge in it is still a dependency of the project. The result keeps no
copy of the dependency list, so a changed lag, or a non-driving link added,
removed or retyped after scheduling, is not detected: re-run `schedule()` after
editing a project. Loading is bounded too: `from_dict` and `from_json` refuse more
than `MAX_DEPENDENCIES` nodes or edges, deeply nested or duplicate-key JSON, a
`format_version` that is not the integer `1`, and keys the format does not define.
Node and edge order, a node whose `early_start` follows its `early_finish`, and a
`project_start` after `project_finish` are accepted: the loader checks structure,
not schedule plausibility.

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
    sprint_length_days=10,                   # required for velocity forecasting
)
```

`monte_carlo()` then forecasts `sprint_work` from the team's own velocity history
rather than from a PERT guess nobody on the team would stand behind, while every
other task in the same run still uses its three-point estimate.
`DeliveryMode.WATERFALL` (the default) is unaffected; mixing modes is opt-in per task.

**`sprint_length_days` is required.** It defaults to `None`, and without it no
sprint has a length, so every SCRUM task falls back to its three-point estimate or
its fixed `duration`. From 0.5, a value of `0` or below will be refused with
`InvalidScheduleInput`. From 0.5, a fallback will no longer be silent:
`MonteCarloResult.velocity_fallback_reasons` will say why a supplied history was
not used: `"sprint_length_days_missing"`, or `"velocity_history_unusable"` when no
observation is usable or the mean is not positive (an all-zero history)
([#5013](https://gitlab.com/trueppm/trueppm/-/issues/5013)).

> **Experimental.** From 0.5 the velocity model will be the shared-capacity model
> below ([ADR-1412](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/1412-shared-team-capacity-velocity-forecasting.md)).
> It has not yet been checked against real projects, so treat its bands as a model.
> In 0.4 each story drew the whole team's velocity for itself and was rounded up to
> whole sprints, which inflated chains of small stories and let parallel stories
> share no capacity ([#5011](https://gitlab.com/trueppm/trueppm/-/issues/5011)).

From 0.5 the semantics will be:

- **One capacity per run.** Each run draws one per-sprint velocity vector from
  `velocity_samples`, and every SCRUM task with `story_points` consumes it. Sprint
  `k` opens `k * sprint_length_days` working days of the project `calendar` after
  the data date (`status_date`, or `start_date`), and its points are delivered
  evenly over its working days.
- **Fractional sprints.** A story finishes at the point in a sprint where its last
  point is delivered. It is not rounded up to a whole sprint.
- **Sequential stories add up; parallel stories compete.** Stories claim capacity
  in topological order, ties by task id, from the moment their predecessors (scrum
  or not) let them start. Capacity before that moment is not spent on them.
- **Progress is remaining points.** An in-progress story needs
  `story_points * (1 - percent_complete / 100)` points; no elapsed days are read
  off `duration`, so the forecast shrinks as points burn down
  ([#5012](https://gitlab.com/trueppm/trueppm/-/issues/5012)).
- **The plan is still the floor, with one known exception.** A story never takes
  less than its `duration` less its elapsed days, so on a network of FS and SS links
  Monte Carlo does not land before `schedule()`. An FF or SF link that pulls a
  story's start earlier, and an SS successor that inherits that start, can still
  land a run before the CPM finish ([#5042](https://gitlab.com/trueppm/trueppm/-/issues/5042)).
  A test pins that behavior so it flips when the issue is fixed.
- **Why 0% and 50% can forecast the same date.** The data date moves with progress:
  a story that is 50% done at a later `status_date` needs half the points but starts
  later, so at a data date that follows the progress the two can land together.
  Hold the data date fixed and the forecast shrinks as progress grows.

Worked examples, with a team that delivers exactly 20 points every sprint and
10-working-day sprints from Monday 2026-01-05:

- Ten sequential 2-point stories are 20 points, one sprint: P50 is 2026-01-16
  (10 working days). In 0.4 it was 100 working days, a sprint per story.
- Five parallel 20-point stories are 100 points, five sprints: P50 = P95 =
  2026-03-13 (50 working days). In 0.4 it was one sprint, every story using the
  whole team.

`sprint_length_days` counts working days of the project `calendar`, the calendar
the team's sprints run on. A scrum task on its own per-task calendar takes the
same sprints of calendar time: from 0.5, two 10-day sprints on a Mon/Wed/Fri task
calendar will end where they end on the project calendar, instead of being laid
out as 20 Mon/Wed/Fri days. The sprint span is measured from the data date
(`status_date`, or `start_date`), so a holiday on the project calendar is read
there rather than at each run's start
([#4529](https://gitlab.com/trueppm/trueppm/-/issues/4529)).

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
| `p50` | Half the simulated runs finished on or before this date. It sits later than the CPM finish by the expected slip. | A midpoint, never a commitment |
| `p80` | 4 in 5 runs finished by this date. | **The commitment date** — internal and stakeholder plans |
| `p95` | 19 in 20 runs finished by this date. | Contractual deadlines, launch dates, regulatory submissions |

So a CPM finish of `2026-03-03` and a P80 of `2026-03-14` do not disagree. They
say: *the plan can finish on March 3, and it will finish by March 14 four times
out of five.* From 0.5, on a network of FS and SS links no simulated run will finish before
the CPM date (0.4 could place a percentile on or before it), so it is the floor of the distribution: the odds of hitting it are
low, and they fall toward zero as more tasks carry an estimate. Committing to it
(or to a date between it and P50) is committing to a
long shot. FF and SF links are the exception: they can pull a finish earlier than CPM.

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

### Reading the result

Each task in `result.tasks` carries several date fields. For a task that has not
started they coincide; for work in progress they do not, and drawing the wrong one
makes a half-done task look like it has barely begun.

| Field | Meaning |
|-------|---------|
| `early_start` | Start of the **remaining** work. For an in-progress task this is the data date (`status_date`), not the day work began. |
| `scheduled_start` | Start of the task's **whole span**: `actual_start` when recorded; for in-progress work with no `actual_start`, the full duration backed off from `early_finish`; otherwise (not started or complete) `early_start`. Draw bars from this. |
| `early_finish` | Finish of both the remaining work and the whole span. Remaining work ends when the task ends. |
| `milestone_at_day_end` | For a zero-duration milestone, whether `early_finish` is the end of that day (`True`) or the start of it (`False`). Never diff two shown days as a slip; see the `ScheduleResult` docstring. |
| `critical_path` | Every critical task id, in lexicographic-topological order (by `early_start`, then id). It is a list of tasks, not one chain, and it is empty when no task is critical, for example when every task is complete. |
| `driving_edges` | The dependencies that bind their successor or have zero relationship free float, sorted deterministically. |

For example, a 10-day task that began on 2026-01-05, is 25% complete, and is
scheduled with a `status_date` of 2026-01-12:

```python
task = Task(
    id="A", name="A", duration=timedelta(days=10),
    percent_complete=25, actual_start=date(2026, 1, 5),
)
result = schedule(Project(
    id="p", name="p", start_date=date(2026, 1, 5),
    status_date=date(2026, 1, 12), tasks=[task], dependencies=[],
))
# early_start     == date(2026, 1, 12)   remaining work starts at the data date
# early_finish    == date(2026, 1, 21)
# scheduled_start == date(2026, 1, 5)    the span began when work did
```

### Summary tasks

`Project` carries no task hierarchy, and `schedule()` has no concept of a summary
(phase) row. Every task it is given is scheduled as an ordinary leaf. Pass a phase
straight in and a 0-duration phase becomes a milestone at the project start, and a
link from it constrains only its direct successor, not the phase's leaves, with no
error. If your data has a WBS (an MS Project import, for example), call
`expand_summary_dependencies(tasks, deps, children_map)` first, then schedule what
it returns:

```python
from datetime import date, timedelta
from trueppm_scheduler import (
    Calendar,
    Dependency,
    DependencyType,
    Project,
    Task,
    expand_summary_dependencies,
    schedule,
)

tasks = [
    Task(id="phase", name="Phase 1", duration=timedelta(0)),  # the summary row
    Task(id="design", name="Design", duration=timedelta(days=2)),
    Task(id="build", name="Build", duration=timedelta(days=3)),
    Task(id="test", name="Test", duration=timedelta(days=2)),
]
deps = [
    Dependency(predecessor_id="design", successor_id="build", dep_type=DependencyType.FS),
    Dependency(predecessor_id="phase", successor_id="test", dep_type=DependencyType.FS),
]
children_map = {"phase": ["design", "build"]}  # summary id -> direct child ids

leaf_tasks, leaf_deps = expand_summary_dependencies(tasks, deps, children_map)
project = Project(
    id="p-1",
    name="With a phase",
    start_date=date(2026, 1, 5),
    tasks=leaf_tasks,
    dependencies=leaf_deps,
    calendar=Calendar(),
)
result = schedule(project)
test = next(t for t in result.tasks if t.id == "test")
print(test.early_start)  # 2026-01-12: Test waits for Build, the phase's last leaf
```

Scheduling `tasks` and `deps` directly, without the expansion, starts Test on
2026-01-05, because the link from `phase` reaches nothing but Test.

The rules about summary links belong to `expand_summary_dependencies`, not to
`schedule()`: it removes the summary rows, fans each FS and FF link out to the
leaves, and rejects an SS or SF link *from* a summary, and an FF or SF link *into*
one, with `InvalidScheduleInput`
([ADR-0370](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0370-reject-ss-sf-from-summary-tasks.md),
[#4437](https://gitlab.com/trueppm/trueppm/-/issues/4437)).
`schedule()` never sees a summary, so it never raises for one.

## Helpers and result types

Smaller exported names that the sections above do not cover:

- `find_cycle(edges)` returns a `CycleCheck`. Its `.cycle` is the offending task ids in order, with the first repeated at the end (`["A", "B", "C", "A"]`), or `None` when the graph is acyclic. It is truthy only when a cycle exists.
- `expand_summary_dependencies(tasks, deps, children_map)` returns a `SummaryExpansion`: `.tasks` is the input with summary tasks removed (leaves only) and `.dependencies` is every dependency fanned out to leaf-level edges. It still unpacks as `leaf_tasks, deps = ...`. From 0.5, a link whose two endpoints share a leaf (a summary linked to itself, to one of its own descendants, or from one) will raise `CyclicDependencyError` naming that source link, so `.cycle` will be `[pred, succ, pred]` (or `[pred, pred]` for a link to itself): it is the same input `find_cycle` reports as a cycle. A Start-to-Start or Start-to-Finish link *from* a summary, or a Finish-to-Finish or Start-to-Finish link *into* one, will still raise `InvalidScheduleInput` instead, because the ADR-0370 check runs first. 0.4 silently drops such a link or turns it into an invented sibling order ([#4538](https://gitlab.com/trueppm/trueppm/-/issues/4538), [#4705](https://gitlab.com/trueppm/trueppm/-/issues/4705)). The MS Project, CSV and Jira importers do not yet refuse such a link at import time ([#4856](https://gitlab.com/trueppm/trueppm/-/issues/4856)). From 0.5, a cyclic `children_map` will raise `InvalidScheduleInput` whether or not any link touches the cycle (0.4 accepts one no link names and silently drops its tasks), two links on the same pair of plain tasks will raise the same "Duplicate dependency" error `schedule()` does whether or not `children_map` is empty (0.4 merges them when it is not), the result's lists will never be the ones you passed in, and a summary expansion past `MAX_EXPANDED_EDGES` will be refused from leaf counts in time linear in the size of `children_map`, where 0.4 took time quadratic in nesting depth to refuse it ([#5014](https://gitlab.com/trueppm/trueppm/-/issues/5014), [#5018](https://gitlab.com/trueppm/trueppm/-/issues/5018), [#5019](https://gitlab.com/trueppm/trueppm/-/issues/5019)).
- `ScheduleResult.driving_edges` is a list of `DrivingEdge`: the links that bind their successor or have zero relationship free float. A link binds when the date it imposes, read in the successor's working time, is the successor's early date. The set is the union of the two, so at a merge it can name a zero-free-float link that does not bind. Free float stays a separate output: a seven-day-week predecessor finishing on a Friday into a Monday-to-Friday successor drives it onto Monday and still has two days of free float, its Saturday and Sunday ([#4704](https://gitlab.com/trueppm/trueppm/-/issues/4704)).
- `MonteCarloResult.sensitivity` is a list of `TaskSensitivity` (`task_id`, `index`). `index` is the absolute Spearman rank correlation, from 0 to 1, between the task's sampled duration and the project finish. Tasks whose duration cannot vary the finish are omitted rather than reported as 0.
- From 0.5, `MonteCarloResult.velocity_saturated_runs` will count the runs in which an open scrum task's velocity draw reached the end of the run's drawn team capacity (`ceil(remaining backlog / mean) * 4 + 10` sprints plus the sprints before the last story can start, capped at `MAX_VELOCITY_SPRINTS`; ADR-1412) without burning down. Those runs will be clamped to the horizon, so when it is non-zero (`velocity_tail_truncated` is `True`) read P80/P95 as lower bounds, not estimates. It will be `0` for a project with no velocity path. ([#2469](https://gitlab.com/trueppm/trueppm/-/issues/2469))
- From 0.5, `trueppm_scheduler.calendar` will expose the engine's own working-day walks, so an embedder counts and steps days with the rule `schedule()` uses instead of a hand-rolled `date + timedelta` loop ([#5009](https://gitlab.com/trueppm/trueppm/-/issues/5009)). All four are also importable from `trueppm_scheduler`. `working_day_count(start, finish, calendar)` counts the working days in `[start, finish]`, both ends inclusive (`0` when `finish < start`). `next_working_day(day, calendar)` and `previous_working_day(day, calendar)` return the nearest working day strictly after or before `day`; pass `inclusive=True` to get `day` itself when it is a working day. `nth_working_day(start, n, calendar)` is the "add working days" helper: the `n`-th working day of a span whose day one is the first working day on or after `start`, the same rule that lays a task's duration onto its calendar (`n <= 0` returns `start`). Each walk is bounded by `MAX_CALENDAR_SCAN_DAYS` and raises `InvalidScheduleInput` on a calendar with no working day in that window.
- From 0.5, `roll_up_summary(task_id, leaves, *, name=None)` will derive a summary task's row from its scheduled leaves, since `schedule()` returns leaves only ([#5010](https://gitlab.com/trueppm/trueppm/-/issues/5010)). Starts (`early_start`, `scheduled_start`, `late_start`) take the earliest leaf value and finishes the latest; `total_float` is the tightest leaf float (a group is only as flexible as its least flexible work), `free_float` is zero, and the row is critical when any leaf is. It returns `None` when no leaf has both an early start and an early finish.
- From 0.5, `forecast_velocity_delivery(remaining_points, velocity_samples, *, sprint_length_days, today, runs=1000, seed=...)` and `forecast_throughput_delivery(weekly_throughput, remaining_count, *, today, runs=1000, seed=...)` will bootstrap a team's pace history (points per sprint, items per week) and return a `DeliveryForecast`: `p50_periods` / `p80_periods` (sprints, or weeks for throughput) and `p50_date` / `p80_date` / `p95_date` projected from `today`, plus `horizon_saturated` (the upper percentiles are lower bounds when true). Both return `None` when there is no usable pace signal. A fixed `seed` reproduces the forecast on the same numpy and scheduler versions. `duration_percentiles(values)` returns whole-unit `p50`/`p80`/`p95` of a sample (all `None` when empty), and `velocity_band_dates(cpm_finish=..., remaining=..., sprint_days=..., velocity_low=..., avg=...)` returns the coarse velocity-band `(p50, p80, p95, usable)` finish dates.
- `perturb_task_duration(project, task_id, delta_days)` returns a copy of the project with one task's duration shifted, for what-if runs. It moves the fixed duration, the three-point estimate and the story points together, so the CPM finish and the Monte Carlo bands stay consistent. The input project is not mutated.

## Conventions

Every modeling rule the engine commits to, one line each, with the issue or ADR
that decided it. **Differs** marks the rules where a schedule built in MS Project
or Primavera P6 can come out differently here; everything else follows their
convention. The same list, with the comparison spelled out, is on
[Scheduler Conventions](https://docs.trueppm.com/features/scheduler-conventions/).

> **This list describes `main`, which ships as 0.5.** Several rules below changed
> after the 0.4.0 tag, mainly the milestone, completed-task and in-progress rules,
> the `is_critical` rule, and every Monte Carlo rule about fractional finishes,
> zero-duration tasks and percentile reading (#4458, #4527, #4601, #4690, #4697,
> #4698, #4703, #4704). On 0.4.0, read the `[0.4.0]` section of
> [`CHANGELOG.md`](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/CHANGELOG.md)
> and the README at the `scheduler-v0.4.0` tag; the 0.5 changes are the
> `[Unreleased]` entries there.

**Units and calendars**

- Durations and three-point estimates count **working days**, in **whole days only**; a sub-day duration or lag raises `InvalidScheduleInput`. **Differs** — both tools schedule in hours. ([#826](https://gitlab.com/trueppm/trueppm/-/issues/826))
- `Calendar.hours_per_day` and `Calendar.timezone` are **inert** — they round-trip and change no date. **Differs.** ([#4131](https://gitlab.com/trueppm/trueppm/-/issues/4131))
- Lag counts **calendar days**; the resulting date always snaps **forward** to the successor's next working day — a lead (negative lag) follows the same rule and never snaps backward. **Differs** — MS Project and P6 count lag in working time by default. ([#2534](https://gitlab.com/trueppm/trueppm/-/issues/2534); open question [#2535](https://gitlab.com/trueppm/trueppm/-/issues/2535))
- Per-task calendars: duration expands on the task's own calendar, lag is consumed on the successor's. ([ADR-0120](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0120-cross-project-dependencies-within-program.md))

**Links and constraints**

- An **FF/SF**-driven task stays contiguous and right-aligned on its pinned finish, so its start moves back — the MS Project convention. Consequence: CPM is non-monotone in duration on an FF/SF network (a longer task can start earlier). ([#3806](https://gitlab.com/trueppm/trueppm/-/issues/3806), decided: keep)
- A zero-lag **FF** and a zero-lag **SS** on a whole-day Standard calendar reproduce the Start/Finish MS Project itself computed and saved for the same tasks — confirmed against a real MS Project export (`LinkTypes.mpp`), not just the documented rule. ([#4323](https://gitlab.com/trueppm/trueppm/-/issues/4323))
- An **SF** link finishes the successor at the start of the predecessor's start day — with zero lag, its last working day is the day before. A positive lag counts from the predecessor's start itself, so a weekend just before it cannot absorb the lag (a Monday start with `SF+2d` finishes the successor Tuesday); a lead counts back from the zero-lag finish. **Verified** for the zero-lag, ordinary-work case against a real MS-Project-saved schedule (`tests/fixtures/msproject/link_types_2013.py`, whose SF predecessor starts on a Tuesday), and now for a positive lag against four independently-corroborated MS-Project-saved alignments (`tests/fixtures/msproject/task_links_cross_version.py`, [#4327](https://gitlab.com/trueppm/trueppm/-/issues/4327)) — including the Monday-start, weekend-adjacent-anchor case [#4333](https://gitlab.com/trueppm/trueppm/-/issues/4333) reports: all four agree with MS Project, confirming the #4333 fix against external file evidence rather than only the hand-built regression test in `tests/test_sf_from_work.py`. **A second, separate divergence remains** ([#2534](https://gitlab.com/trueppm/trueppm/-/issues/2534)): the engine counts lag in **calendar** days and snaps forward once, so a lag long enough to reach a *second* weekend from the anchor again finishes one working day short of MS Project — confirmed on all four alignments by raising their lag past what the saved files actually used (e.g. the Monday-start case agrees through lag=6 and diverges again at lag=7; a mid-week start diverges as early as lag=3). An SF link out of a milestone remains unverified — no MS Project sample found covers it (#4327). ([#4145](https://gitlab.com/trueppm/trueppm/-/issues/4145), [#4322](https://gitlab.com/trueppm/trueppm/-/issues/4322), [#4333](https://gitlab.com/trueppm/trueppm/-/issues/4333), [#2534](https://gitlab.com/trueppm/trueppm/-/issues/2534))
- A task with an **SF link** may be placed before the project start: its project-start floor is the earlier of the project start and its SF placement, which its SF links already enforce, so the project start never holds it back, and a binding FS, SS or FF lead can also place it there. A task with no SF link keeps the floor, so its leads stay floored. A data date or `planned_start` after the project start, and a recorded `actual_start`, hold every task. A shorter lag never finishes work later (a lag into a signed-off milestone does not change its edge, which is its pin; a calendar-day lag out of it can still count from an earlier equivalent midnight, [#4690](https://gitlab.com/trueppm/trueppm/-/issues/4690), so a completed predecessor's lag or finish can move its lagged successors later, never earlier, [#5017](https://gitlab.com/trueppm/trueppm/-/issues/5017); a pin-only link instant is [#5089](https://gitlab.com/trueppm/trueppm/-/issues/5089)); on a network of tasks with work, an FS, SS or FF link that does not bind moves nothing. MS Project's behavior for mixed links and for leads is **unverified** ([#4319](https://gitlab.com/trueppm/trueppm/-/issues/4319)). ([#4218](https://gitlab.com/trueppm/trueppm/-/issues/4218), [#4220](https://gitlab.com/trueppm/trueppm/-/issues/4220))
- **A data date at or before the project start moves nothing, and neither does such a `planned_start` (SNET) on a task with no SF link.** Snapped to the task's calendar, a bound on or before the project's first working day is the project-start floor, so the engine treats it as that floor: every task that takes the project start already has it, and the places that leave it out (an SF-linked task, and the instant a milestone's successors measure their lags from, both below) do not get it back through it. So adding `status_date <= start_date` changes no task's dates, floats or the finish, a `null` status date schedules exactly like one on the start, and an SNET on or before the start changes nothing on a task with no SF link. This matters because callers often default the data date to today: on a project that starts in the future that is a date before the start, and it used to pull a free milestone's successors up to (start − today) days earlier. The data-date half applies to SF-linked tasks too, which is a decision, not a consequence: a sub-start data date could hold an SF-linked task that its link places even earlier, and it no longer does. An SNET on an SF-linked task is kept verbatim, even before the start: such a task takes no project-start floor, so the SNET can only hold it later than its links place it, and snapping a task to the project start (or moving the start to it) writes exactly that SNET. A recorded `actual_start` is kept verbatim, because a fact may precede the plan. A data date or SNET after the start binds as before. ([#4635](https://gitlab.com/trueppm/trueppm/-/issues/4635))
- A zero-duration **milestone** is an instant: at the end of its driver's finish day, or the start of the day a floor holds it to. A lag that places it after a weekend or holiday shows it at the start of the next working day (a predecessor's recorded finish on a non-working day is read as the end of the working day before it, so it does not — [#4631](https://gitlab.com/trueppm/trueppm/-/issues/4631)) — confirmed for the work-driven case against a real MS Project export with all 10 zero-duration milestones in a saved `.mpp` chain. The project start only bounds the day a milestone is shown on: a milestone that a lead or an SF-placed predecessor puts before it is shown on the project's first working day (unless it has an SF link of its own), but its successors' lags count from the earlier point — **unverified** against MS Project or P6 ([#4225](https://gitlab.com/trueppm/trueppm/-/issues/4225)). Its start and finish are one instant, so an FF link into a milestone places it exactly where FS does, a lagged SF link places it on its anchor plus the lag (a positive lag counts from the predecessor's start itself), and an FF link out of it measures a positive lag from that instant; with no lag or a lead it counts from the end of the working day before the milestone, so a longer lead never finishes the successor later. ([#4079](https://gitlab.com/trueppm/trueppm/-/issues/4079), [#4173](https://gitlab.com/trueppm/trueppm/-/issues/4173), [#4225](https://gitlab.com/trueppm/trueppm/-/issues/4225), [#4272](https://gitlab.com/trueppm/trueppm/-/issues/4272), [#4273](https://gitlab.com/trueppm/trueppm/-/issues/4273), [#4323](https://gitlab.com/trueppm/trueppm/-/issues/4323))
- The **only** date constraint is start-no-earlier-than, via `planned_start`; `planned_finish` is reserved and inert — no deadline, finish, must-start-on or ALAP constraint. **Differs.** ([#3345](https://gitlab.com/trueppm/trueppm/-/issues/3345), [#804](https://gitlab.com/trueppm/trueppm/-/issues/804))
- An **SS or SF link from a summary task** is rejected by `expand_summary_dependencies` with `InvalidScheduleInput` (FS/FF from a summary expand to its leaves). `schedule()` itself has no summary concept: run the expansion first ([Summary tasks](#summary-tasks)). **Differs** — MS Project accepts it. ([ADR-0370](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0370-reject-ss-sf-from-summary-tasks.md))
- An **FF or SF link into a summary task** is rejected the same way, from 0.5: a summary finishes with its latest leaf, so fanning the link out to every leaf would make each short leaf finish with the predecessor too. FS/SS into a summary expand to its leaves. 0.4 fans an FF/SF link into every leaf. **Unverified** against MS Project. ([#4437](https://gitlab.com/trueppm/trueppm/-/issues/4437))

**Progress and actuals**

- An open task with **no remaining work** (`Task.zero_remaining`, new in 0.5, set by `perturb_task_duration` when a pull-in uses up the remaining work) keeps its `duration` and `percent_complete`. It is placed as an instant like a milestone, so FS and FF links out of it measure from that instant, while its SS and SF links keep measuring from its recorded `actual_start`, or, when none is recorded, from the instant ([#5182](https://gitlab.com/trueppm/trueppm/-/issues/5182)). A bigger pull-in therefore never finishes later than a smaller one on any link type. Ignored on a completed task and a milestone. ([ADR-1474](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/1474-open-work-with-no-remaining-work.md), [#4819](https://gitlab.com/trueppm/trueppm/-/issues/4819))
- A **completed** task (`actual_finish` set, or 100%) is pinned to its recorded dates verbatim — even on a non-working day — and is never re-sampled. With no recorded actuals it is pinned at the project start (or its `planned_start`, when later); no predecessor moves it. From 0.5 it never finishes after the data date (`status_date`): when that span would run past it, the task is laid back to finish on the data date (the working day before it, when the data date is not a working day), so recording no actuals can never slip the schedule further than recording an `actual_finish` on the data date would. 0.4 can push it, and its successors, past the data date ([#4539](https://gitlab.com/trueppm/trueppm/-/issues/4539)). A completed milestone stays an instant: with no actuals at the start of its pinned day; with actuals on its recorded `actual_finish` (else `actual_start`) day — `early_start` and `scheduled_start` included, even when an earlier `actual_start` is recorded ([#4458](https://gitlab.com/trueppm/trueppm/-/issues/4458)) — at the start of that day, unless `Task.live_day_end_on` (the day your previous run showed it at the end of; the TruePPM API passes it back on every run) names that day, in which case at the end of it. From 0.5 the sign-off pin is authoritative: a signed-off milestone's edge reads nothing about its predecessors — not their actual finishes, not their links or lags, not whether they are still open — so recording a later actual finish on a predecessor, correcting completed work, deleting a link or editing a lag on a completed link never flips it ([#5017](https://gitlab.com/trueppm/trueppm/-/issues/5017)). The edge is the pin; a calendar-day lag out of a milestone closed at the start of its day can still count from an earlier equivalent midnight ([#4690](https://gitlab.com/trueppm/trueppm/-/issues/4690), below), so a completed predecessor's change can move its lagged successors later, never earlier; a pin-only link instant is [#5089](https://gitlab.com/trueppm/trueppm/-/issues/5089). Before that the edge was read from where completed work's links placed the milestone, capped at the sign-off day, and that was not monotone: a predecessor finishing on the sign-off day put the milestone at the end of it, one finishing a day later did not, so the later finish pulled the successors a working day earlier ([#4703](https://gitlab.com/trueppm/trueppm/-/issues/4703), [#5017](https://gitlab.com/trueppm/trueppm/-/issues/5017)). Closing a milestone on its forecast day keeps the edge its successors measure from when you pass your previous run's output back; without the hand-back, a milestone placed live by work finishing that day sits at the start of it once closed, and its FS successors move a working day earlier ([#4433](https://gitlab.com/trueppm/trueppm/-/issues/4433), [#4525](https://gitlab.com/trueppm/trueppm/-/issues/4525)). Once every predecessor is complete, that includes the successors' calendar-day lags: a milestone shown at the start of a day can sit at an earlier midnight (Sunday 00:00 shown on Monday, or a point before the project start), and once closed it still links from that midnight, read from its completed predecessors. That reading only picks which midnight equivalent to the pinned day a calendar-day lag counts from, and never an earlier one for a later predecessor finish. **Closing a milestone while one of its predecessors is still open can still move its lagged successors, as before:** the open work's forecast is not read, so it links from the start of its recorded day ([#4740](https://gitlab.com/trueppm/trueppm/-/issues/4740)). Recording an `actual_start` on the day a live milestone is shown, or a `planned_start` or data date that falls on, or snaps to, that day (a weekend date snaps to the Monday), moves nothing. For the data date and for a `planned_start` that snaps to the day, this is a change to live schedules, and an earlier-only one: before it, such a date pushed the milestone's lagged successors later ([#4690](https://gitlab.com/trueppm/trueppm/-/issues/4690)). From 0.5, slipping a predecessor never moves a floored milestone's successors earlier: a milestone held by a data date, `planned_start` or recorded `actual_start` links from the later of its link and the close of the last working day before that floor (Saturday 00:00 for a Monday floor, or a verbatim Sunday `actual_start`, on a Monday-to-Friday week), not from the floor itself, so recording a milestone's start a day later never moves its successors earlier either. This changes live schedules: a successor on a wider calendar can sit on the weekend before a Monday-floored milestone, and a calendar-day lag out of it counts from that Saturday, so `M -FS+2cd-> B` with `M` held at Monday puts `B` on Monday rather than Wednesday. In 0.4 the floor's own midnight was used unless the link tied it, so a predecessor slipping into the tie could move the successors earlier by as many calendar days as the non-working time before the floor (two across a weekend) ([#4883](https://gitlab.com/trueppm/trueppm/-/issues/4883)). ([ADR-0136](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0136-completed-task-full-duration-span.md))
- An **in-progress** task schedules its remaining `duration − floor(duration × pct / 100)` working days forward from the data date (`status_date`), floored at its unsnapped `actual_start` and at its `planned_start` (SNET), which acts as "resume no earlier than": a later SNET holds the remaining work there while `scheduled_start` stays on `actual_start` ([#4527](https://gitlab.com/trueppm/trueppm/-/issues/4527)). ([ADR-0132](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0132-data-date-aware-progress-forecasting.md))
  - **The elapsed days are exact.** In 0.4 it is float arithmetic, `int(duration * pct / 100.0)`, which is exact for whole-number percents but can floor a day short on a fractional one: a 375-day task at 18.4% counts 68 elapsed days, not 69. From 0.5 it will be exact rational arithmetic on the decimal the percentage prints as (its shortest round-trip form, Python's `repr`), so 18.4 will mean 18.4 rather than the stored double `18.39999…`: with `x = duration × P / 100`, elapsed will be the nearest whole day when `x` is within 1e-9 days of it, and `floor(x)` otherwise. The tolerance is for percents derived as `100 × k / n`, which print as a repeating decimal cut at 17 digits (`11.11111111111111` for 1 of 9 days) and would otherwise count one day fewer about half the time. Below 100% elapsed will then be capped at `duration − 1`, so any percentage below 100 will still leave at least one working day of remaining work. Whole-number percents schedule exactly as before. Monte Carlo and `perturb_task_duration` will use the same rule. ([#5034](https://gitlab.com/trueppm/trueppm/-/issues/5034))

**Float and output**

- `is_critical` is `total_float == 0` on live work; completed work has total float 0 and is never critical, so filter on `is_critical` (or `critical_path`), not on `total_float == 0` alone. Total float is the working days from early to late start. From 0.5 that will hold for milestones too: a start-of-day milestone whose float runs to a non-working midnight (weekends and holidays) will show its late start on the next working day after it, where 0.4 shows the working day before ([#4528](https://gitlab.com/trueppm/trueppm/-/issues/4528)). A milestone whose float stops early because a milestone linked after it with no lag works a narrower week will show its late start on the day its float stops; 0.4 shows it a working day later, and from 0.5 its `total_float` is a working day shorter too ([#5092](https://gitlab.com/trueppm/trueppm/-/issues/5092)). That late start is the latest the milestone can start *when it is itself held there*; when its predecessor places it on that day, a calendar-day lag out of it runs from that day's midnight instead of the non-working one, and `project_finish` can move. Whether lag counts calendar or working days is a separate open decision ([#2535](https://gitlab.com/trueppm/trueppm/-/issues/2535)).
- `free_float` inverts the forward constraint across **all four** link types, capped at total float; no live successor → total float. ([#1828](https://gitlab.com/trueppm/trueppm/-/issues/1828))
- The order of `ScheduleResult.tasks` is **unspecified** — look tasks up by `id`. ([#1862](https://gitlab.com/trueppm/trueppm/-/issues/1862))
- `project_finish` and a milestone's `early_finish` are the **day the finish is shown on**, and `milestone_at_day_end` says which edge of it. The end of a Friday and the start of the next Monday are the same point in working time, so the shown day can hop a weekend or holiday with no working-time move. **Compute slip in working time**, reading a start-of-day milestone finish as the end of the working day before it — never as a calendar-day difference of two finishes. ([#4178](https://gitlab.com/trueppm/trueppm/-/issues/4178))
- The same holds for Monte Carlo: `MonteCarloResult.p50`/`p80`/`p95` are shown days, and `p50_at_day_start`/`p80_at_day_start`/`p95_at_day_start` say which edge of each. Compare a percentile with the CPM finish, or with another run's percentile, in working time. ([#4204](https://gitlab.com/trueppm/trueppm/-/issues/4204)) These are read-only properties over `MonteCarloResult.percentiles`, a `dict[int, Percentile]` of the levels that were computed (`Percentile(date, at_day_start)`), so `result.percentiles[80].date` equals `result.p80`. ([#4514](https://gitlab.com/trueppm/trueppm/-/issues/4514))

**Monte Carlo**

- Three-point estimates sample a Beta **fitted by method of moments to the classic PERT mean `(O + 4M + P) / 6` and σ = `(P − O) / 6`** — not the λ=4 Beta-PERT. Same mean; on a symmetric estimate the band is ~12% narrower (P80/P95 slightly earlier), on one whose mode sits at an end it is wider. **Differs** from @RISK's default. ([ADR-1245](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/1245-pert-sampler-moment-fit-convention.md), [#4133](https://gitlab.com/trueppm/trueppm/-/issues/4133))
- Every sampled duration is **floored at `Task.duration`** — the optimistic tail below the plan is not expressed. **Differs** — risk tools sample the whole estimate. ([#3765](https://gitlab.com/trueppm/trueppm/-/issues/3765))
- A zero-duration task with a sampled duration (a three-point estimate, or story points on the velocity path) is decided **run by run**. A draw under half a day rounds away: it leaves the task the instant `schedule()` places, links and lags included, and hands no fraction on to the work after it. Three 0.2-day draws in a chain therefore cost nothing, although they add up to 0.6 of a day of work. A larger draw is simulated as work. With no recorded start that is the same as a task of that length with the same link; a started zero-duration task can differ from a started real task. A `(0, 0, 1)` estimate therefore leaves P50 on the CPM finish. On a network with FF or SF links a work-sized draw can back-solve a start, so a run can finish before CPM ([#4822](https://gitlab.com/trueppm/trueppm/-/issues/4822)). ([#4698](https://gitlab.com/trueppm/trueppm/-/issues/4698))
- Sampled durations are continuous, and a run's finish is shown on **the day its work ends in** (`ceil(offset) - 1`): work ending 0.3 of the way into a Monday finishes on Monday. Lagged links read the same day and carry the fraction while the lag lands in working time, and a milestone after fractional work sits at that point in working time. A run with no spread lands exactly on the CPM finish. A zero-duration task's draw under half a day is exempt and rounds away. A percentile interpolated between two whole-day positions is read on the later day. ([#4697](https://gitlab.com/trueppm/trueppm/-/issues/4697))
- Percentiles are `numpy.percentile`'s linear interpolation over all runs, so a reading can fall on a day no run finished on, between two runs far apart. Its precision then depends on the run count: with `n` runs a P*q* reading has **more than `q × (1 − 1/n)` percent** of runs on or before it, never fewer. At the default 10,000 runs that is within 0.01 points; at 10 runs a P95 can have only 90% of runs on or before it. Use at least a few hundred runs before quoting P95 as a commitment. An exact midpoint between two runs (an even run count's P50 between two days) is read on the later day, not rounded half-to-even. ([#4540](https://gitlab.com/trueppm/trueppm/-/issues/4540))
- "Never before the CPM finish" holds **only on FS/SS-only networks**; on an FF/SF network a percentile can land earlier, because CPM itself is non-monotone there. ([#3806](https://gitlab.com/trueppm/trueppm/-/issues/3806))
- A fixed `seed` reproduces P50/P80/P95 on the **same numpy and `trueppm-scheduler` versions** — see [Reproducibility](#reproducibility-seeded-runs). ([#4099](https://gitlab.com/trueppm/trueppm/-/issues/4099))

## Errors and input limits

Every exception the engine *documents* raising subclasses `ValueError` (via the
common `SchedulerError` base), so one `except ValueError` catches them all — but
each is individually catchable:

| Exception | Raised when |
|-----------|-------------|
| `CyclicDependencyError` | The dependency graph contains a cycle. `.cycle` lists the task IDs forming it. From 0.5, it will be the full canonical path (deterministic, starts at its smallest ID, repeats it at the end), and the message will `repr()`-escape IDs and truncate after 10 with `… (+M more)`. |
| `SimulationCapExceeded` | `monte_carlo(runs=…)` exceeds `max_runs`, or the project has more tasks than `max_tasks`. |
| `SimulationTimeExceeded` | From 0.5: `monte_carlo(deadline=…)` passed its `time.monotonic()` deadline before the run finished. A subclass of `SimulationCapExceeded`, so a handler for the size caps catches it too. The deadline is checked at phase boundaries (sampling, each forward-pass chunk, the sensitivity tornado), so a run can overshoot it by up to one phase. |
| `InvalidScheduleInput` | The input is structurally valid but out of range, or the wrong type (see below), including `monte_carlo`'s own `sensitivity_cap`, `max_runs`, `max_tasks`, `max_lag_delta_cells` and (from 0.5) `max_index_cells`. From 0.5, messages that echo a value will cap it at 200 characters. |
| `UnknownTaskError` | `derive_value(project, task_id, …)` is called with a `task_id` that names no task in the project. From 0.5, it is also raised when (with a supplied `result`) a dependency of that task names a task the `result` lacks. |

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
- **Project span** — in 0.4, the cumulative span (every task's worst-case duration
  plus the magnitude of every lag) must stay under `MAX_PROJECT_SPAN_DAYS`
  (`366_000`, ~1000 years), regardless of task count. From 0.5 the longest dependency chain will
  be measured instead: each task weighs its worst-case
  duration (the deterministic duration or the largest PERT estimate); the bound will be
  the heaviest chain of those weights plus the magnitude of each lag along it, plus
  one more term added once: the furthest of the latest `planned_start` pin
  (start-no-earlier-than), the data date (`status_date`) offset, and the furthest
  recorded actual from the project start. Parallel tasks will not add up, so task
  count alone will never trip it. A scrum task's velocity worst case
  (`(ceil(story_points / mean velocity) * 4 + 10) * sprint_length_days` working
  days) will be weighed on the same chain, and the uncapped sprint horizon summed over
  every scrum task must also stay under `366_000` sprints, which bounds the velocity
  sampler's total draws. A cyclic graph has no longest chain; it falls back to the
  serial sum and is then reported as a cycle. Four separate refusals will sit beside
  it: a `status_date` more than `MAX_PROJECT_SPAN_DAYS` after the start, an
  `actual_start`/`actual_finish` more than that from the start, a start date so
  close to `date.max` that the walk would overflow the date range, and, when a
  started task with no `actual_start` has its start derived backward from its
  progress, a start date that close to `date.min` (the same span x 7 + one scan
  estimate). Before 0.5 that last case raised a bare `OverflowError` instead of
  `InvalidScheduleInput`.
- **Project work** — from 0.5, the sum of every task's worst-case duration plus every lag's
  magnitude must stay under `MAX_PROJECT_WORK_DAYS` (`3_660_000`, 10x the span cap);
  0.4 has no such limit. This will bound the CPU the passes spend (they walk the calendar per day of duration),
  not the schedule's length: 100 parallel max-duration tasks sit exactly at the cap
  and take about 2 s to schedule. A 100,000-task project at 20 days each is 2M and
  well under it.
- **Monte Carlo** — `runs` must be `>= 1` and at most `100_000_000` (see the
  `runs` ceiling in [Limits for embedders](#limits-for-embedders)).

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
| `MAX_PROJECT_SPAN_DAYS` | `366000` | Cumulative span in 0.4: every task's worst-case duration plus every lag. From 0.5, longest dependency chain — worst-case task durations plus lags along it plus the furthest pin, data date or actual (~1000 years; see Project span above) |
| `MAX_PROJECT_WORK_DAYS` | `3660000` | From 0.5 (not in 0.4): total work — the sum of every task's worst-case duration plus every lag's magnitude, parallel or not (10x the span cap; see Project work above) |
| `MAX_DEPENDENCIES` | `250000` | Raw dependency-edge count, before summary expansion (`100000` in 0.4; `250000` from 0.5); from 0.5 also the node and the edge count `GraphExport.from_dict` / `from_json` accept |
| `MAX_EXPANDED_EDGES` | `250000` | Leaf-level edges after expanding a summary↔summary dependency (`100000` in 0.4; `250000` from 0.5) |
| `MAX_CALENDAR_EXCEPTIONS` | `100000` | Exception ranges on one `Calendar` |
| `MAX_CALENDAR_SCAN_DAYS` | `36600` | Longest run of consecutive non-working days before a calendar is declared degenerate |
| `MAX_LAG_DELTA_CELLS` | `50000000` | Monte Carlo's `(distinct dep-type/lag combos) x (index span)` precompute. Provisional (see [API stability](#api-stability-and-versioning)) |
| `MAX_INDEX_CELLS` | `25000000` | From 0.5 (not in 0.4): Monte Carlo's `(distinct calendars by content) x (index span)` working-day indices, 8 bytes per cell; over it `monte_carlo()` will raise `SimulationCapExceeded`. Override per call with `max_index_cells`. Provisional (see [API stability](#api-stability-and-versioning)) |
| `MAX_VELOCITY_SPRINTS` | `10000` | Per-run sprint horizon the velocity sampler will bootstrap |
| `MC_SENSITIVITY_CAP` | `20` | Tasks returned by the sensitivity ("tornado") ranking |
| `MC_TARGET_CAP` | `50` | From 0.5: most `targets` one `monte_carlo()` call reports per-task percentiles for; more raises `InvalidScheduleInput` |
| `_MAX_RUNS_ABSOLUTE` | `100000000` | Hard ceiling on `monte_carlo(runs=…)`, enforced regardless of `max_runs`; over it `monte_carlo()` raises `InvalidScheduleInput`. A caller-supplied `max_runs` below `runs` is checked as well and raises `SimulationCapExceeded` instead. Not exported from the package: it is a private engine constant, listed so the number is documented |
| `_MAX_SAMPLE_CELLS` | `250000000` | From 0.5, a hard ceiling on `runs x tasks`. It was sized for a sampled-duration matrix held in full (8 bytes a cell, about 2 GB at the ceiling); from 0.5 that matrix will be replayed a row block at a time above 32M cells, so the ceiling bounds the work rather than one allocation. Over it `monte_carlo()` will raise `SimulationCapExceeded` whatever `max_runs` says, instead of a bare `MemoryError`: 100,000 runs fit a 2,500-task project, 10,000 runs a 25,000-task one. Not exported from the package |

```python
from trueppm_scheduler import MAX_DEPENDENCIES, MAX_DURATION_DAYS, MAX_LAG_DAYS
```

The engine has no task-count cap of its own, and its only run-count cap is the
absolute `100_000_000` ceiling in the table above, which is far past anything a
request handler should accept. From 0.5 the `runs x tasks` product will also be
capped at `_MAX_SAMPLE_CELLS`, so a large run count on a large project is refused
with `SimulationCapExceeded` rather than exhausting memory. `monte_carlo(max_runs=…, max_tasks=…)` are opt-in,
caller-supplied ceilings that default to `None` (no limit beyond that ceiling).
That default is correct for a batch script or notebook that owns the whole machine, and wrong for a synchronous web request:
**`schedule()` and `monte_carlo()` are CPU-bound** (CPM passes over every task
and link, plus a numpy-vectorized sampling pass; from 0.5 a task's duration will
be laid out arithmetically rather than by a day-by-day calendar walk), so a request handler that calls either
directly on untrusted or unbounded input ties up a worker thread or process for
as long as the input demands. Pass `max_runs` and `max_tasks` whenever the
caller is untrusted (and, from 0.5, a smaller `max_index_cells` if it supplies a `calendars` registry; the default 25M cells is 200 MB of index arrays alone at 8 bytes per cell, and the whole process runs larger: the issue's 32-calendar maximum-span repro peaks near 220 MB RSS, and about 63 calendars would be 400+ MB. For a request-scoped caller handling untrusted registries, `max_index_cells=5_000_000` is a sensible start: 40 MB of index arrays, about 12 calendars at the maximum span of ~366k days, roughly 100 MB for the process), and run the call off the request thread with a wall-clock
timeout — a worker/queue, not inline in the view — the same pattern the
TruePPM API itself uses
([#4010](https://gitlab.com/trueppm/trueppm/-/issues/4010)). From 0.5, `monte_carlo(deadline=time.monotonic() + budget)` also
stops a simulation that overruns its budget with `SimulationTimeExceeded`, for the
overruns the size caps cannot see, such as a slow host.

**Concurrency.** `schedule()` and `monte_carlo()` are pure with respect to the
`Project` you pass (they do not mutate it) and keep no module-level mutable state,
so concurrent calls on one process are safe. A `Calendar` is a mutable object with
a lazily built internal index and is **not synchronized**: sharing one across
threads that only read it is fine, but mutating it (reassigning `working_days` or
`exceptions`) while another thread schedules against it is unsupported. Build a new
`Calendar` per change.

**Pickling.** `Project`, `Task`, `Dependency`, `Calendar`, `DateRange`,
`ScheduleResult`, `MonteCarloResult` and `Derivation` pickle and unpickle equal to
the original, under every pickle protocol, so they cross `multiprocessing`, Dask
and Ray process boundaries. An unpickled `Project` schedules to the same result as
the original. A `Calendar`'s warm exception index is carried through the pickle and stays valid.

**`monte_carlo(sensitivity_cap=...)` bounds output, not compute.** The duration
sensitivity tornado scores every task whose sampled duration varies, then keeps the
top `sensitivity_cap`; lowering the cap shortens the returned list but does not make
the call faster. Its cost is bounded by `MC_SENSITIVITY_SUBSAMPLE` (2,000) runs per
task regardless of `runs`.

**`monte_carlo()` default run count.** In 0.4, `monte_carlo(project)` runs **1,000**
simulations unless you pass `runs=`. From 0.5 it will run **10,000**, and the
`trueppm-scheduler monte-carlo` command's `--runs` will default to the same 10,000.
Pass `runs=1_000` to keep the 0.4 behavior. (The 10,000-run timing quoted above is the explicit `runs=10_000` case in 0.4, and the default from 0.5.)

A long calendar exception does not cost more as the dependency graph grows:
calendar-day lookups are index-backed (a cached, bisected merged-interval
index), so both the CPM pass and Monte Carlo snap to the next or previous
working day in `O(log E)` regardless of how many tasks or dependencies
reference that calendar.

## The project document JSON Schema

The shape of the document `Project.from_json` accepts and `Project.to_json` emits is
published as a JSON Schema (draft 2020-12), so a client in any language can validate a
plan before submitting it.

- **Where it lives:** `src/trueppm_scheduler/project.schema.json` in the repository,
  and `trueppm_scheduler/project.schema.json` inside the wheel. Read it with
  `importlib.resources.files("trueppm_scheduler") / "project.schema.json"`.
- **How it is made:** generated from `trueppm_scheduler.models` by
  `scripts/generate_project_schema.py`; never edit it by hand. CI fails when a model
  change is not followed by a regenerate, and validates every conformance fixture
  against it.
- **Versioning:** it versions with the package, because it is generated from the same
  models. A new optional property is a minor change; removing or renaming a property,
  making one required, or narrowing a type or range is a breaking change and follows
  the [API stability](#api-stability-and-versioning) rules.
- **What it does not check:** shape only. Cycles, duplicate task ids, edges naming an
  unknown task, calendar consistency, and the span and duration caps are engine rules a
  schema cannot express, so a document that validates can still be refused. The
  schema's own `description` says so.

The conformance corpus the schema is checked against is published with each release;
see [Testing another implementation against the corpus](https://docs.trueppm.com/architecture/testing-another-implementation/).
It certifies agreement with the reference engine, not correctness.

## API stability and versioning

**The public API is the `__all__` surface of the top-level `trueppm_scheduler`
package** — the names you can import directly from `trueppm_scheduler`
(`schedule`, `monte_carlo`, `Project`, `Task`, `Dependency`, `DependencyType`,
`Calendar`, `ScheduleResult`, `MonteCarloResult`, the exception types, etc.).
Two helpers that API-layer code needs become public in 0.5 — `WorkingDayCounter`
(working days in a half-open span for one calendar) and `collect_leaves` (the
distinct leaf IDs under a summary task); the old `engine._WorkingDayCounter` and
`engine._collect_leaves` names remain as aliases for one release. The graph export
(see [Exporting the graph](#exporting-the-graph)) will be public in 0.5 too: `to_graph`,
`GraphExport`, `GraphNode`, `GraphEdge` and `GRAPH_FORMAT_VERSION`.
Everything else — the `trueppm_scheduler.engine` internals, any underscore-
prefixed helper, and module layout — is **unstable** and may move or change
without notice.

**Provisional names.** Two Monte Carlo memory ceilings are exported because a
request-scoped embedder needs them, but they are counted in the units of today's
implementation rather than in anything a caller observes: `monte_carlo(max_lag_delta_cells=…)`
with `MAX_LAG_DELTA_CELLS`, and `monte_carlo(max_index_cells=…)` with
`MAX_INDEX_CELLS`. They are **provisional**: exempt from the stability of the rest of the public API (which, as the
next paragraph says, may still change before 1.0),
they may be renamed or replaced by an implementation-neutral budget in any release,
and any such change is listed in the changelog. Neither changes a computed value:
a ceiling only decides which inputs are refused.

This package is **`Development Status :: 4 - Beta`** as of 0.4.0b1: the public
API may still change before 1.0. **Pin an exact version** rather than a range:

```
trueppm-scheduler==0.4.0
```

Pre-releases (such as a beta or release candidate) install only when you pass
`--pre`, **or when no final release satisfies the requirement**. A bare
`pip install trueppm-scheduler` therefore resolves to the newest final release
and skips any later pre-release unless you pass `--pre` — which is why pinning
an exact version (above) is the reliable approach. Breaking changes are recorded in
[`CHANGELOG.md`](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/CHANGELOG.md),
which also ships inside the wheel.

### Heads-up: `trueppm_scheduler.engine` becomes a subpackage in 0.5

0.5 will ship `trueppm_scheduler.engine` as an `engine/` subpackage instead of
the single `trueppm_scheduler/engine.py` module. The split has landed on `main`
and ships with 0.5
([#4550](https://gitlab.com/trueppm/trueppm/-/issues/4550)). It is a pure move:
scheduling results do not change.

**Will keep working, unchanged:**

- Every import from the top-level `trueppm_scheduler` package (the `__all__`
  surface above).
- `from trueppm_scheduler.engine import X` for every name importable today,
  including underscore-prefixed helpers. `engine/__init__.py` re-exports them
  for the whole 0.5 line. The one exception is `nx`, the `networkx` module
  alias, which is removed with the `networkx` dependency
  ([#4163](https://gitlab.com/trueppm/trueppm/-/issues/4163)).
- Result objects pickled by 0.4 will still unpickle on 0.5.

**Will need a change on your side:**

- **Patching engine internals in your tests.**
  `unittest.mock.patch("trueppm_scheduler.engine._helper")` or
  `monkeypatch.setattr(engine, "MAX_DEPENDENCIES", 1)` will replace the
  re-exported name. The code that actually calls the helper or reads the
  constant will still see the original, so the patch stops taking effect,
  usually without failing the test. Each submodule imports its own binding of
  what it uses, so point the patch at the submodule that **calls** the helper
  or **reads** the constant, which is not always the one that defines it:
  `MAX_DEPENDENCIES` is defined in `engine.limits` but read by
  `engine.validate`, and `monte_carlo()` builds its graph through
  `engine.montecarlo.run._build_graph`. A name several submodules use needs a
  patch on each.
- Code that reads a class's `__module__`, or tooling keyed on the file path
  `trueppm_scheduler/engine.py` (coverage or lint excludes, for example).
  `ScheduleResult.__module__`, for instance, will read
  `trueppm_scheduler.engine.results`.
- Result objects pickled by 0.5 will not unpickle on 0.4.

Where things will live in 0.5 (every name stays importable from
`trueppm_scheduler.engine`):

| Submodule | Holds |
|---|---|
| `engine.errors`, `engine.limits`, `engine.results` | the exceptions, the `MAX_*`/`MC_*` caps, the result types |
| `engine.calendar_math`, `engine.milestones` | working-day arithmetic, zero-duration milestones as instants |
| `engine.digraph` | the in-package dependency graph: topological sort, strongly connected components, cycle selection |
| `engine.graph`, `engine.summary`, `engine.validate` | graph building and `find_cycle`, summary expansion, input validation |
| `engine.forward`, `engine.backward`, `engine.cpm` | the CPM passes and floats, and `schedule()` |
| `engine.replay` | the milestone state `derive_value` reads back from a `ScheduleResult` |
| `engine.montecarlo.sampling`, `.index`, `.forward`, `.run` | duration sampling and `perturb_task_duration`, the working-day index, the vectorized pass, percentiles and `monte_carlo()` |

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

## Performance

Measured with the opt-in `pytest-benchmark` suite in `tests/benchmarks/bench_engine.py`
(library only: no API, database, or network). These are **local-machine numbers**, not
CI-runner numbers, and the suite asserts no time budget; `tests/test_bench.py` stays the
hard circuit breaker.

- **Host:** Apple M5 Pro (`arm64`), macOS, one process, nothing else deliberately running.
- **Software:** CPython 3.12.6, numpy 2.5.5, pytest-benchmark 5.3.1. The CI image runs Python 3.11, so
  CI-runner numbers will differ from these.
- **Engine version:** the numbers measure the engine at commit `cc5c7ceb2` (this branch's
  base on `origin/main`), which already includes the fixes for #1531 (arithmetic duration
  layout instead of a day-by-day walk) and #2838 (per-task-calendar float computed
  arithmetically via the exception-mask span count). The suite doubles as before/after
  evidence for both: run it against an earlier commit to see the difference.
- **`schedule()`:** 1 warm-up round, then 5 timed rounds of 1 iteration each.
- **`monte_carlo(runs=1000)`:** 1 warm-up round, then 3 timed rounds, seed 4230.
- **Shapes:** `chain` is the worst-case single FS spine, every task with a three-point
  estimate. `mixed` is a seeded branching network (about two predecessors per task within
  a 30-task window, FS/SS/FF with 0-3 day lags, three-point estimates on a fifth of the
  tasks, and tasks spread over the project calendar and two per-task calendars).

Wall time in milliseconds, mean of the timed rounds (best round in parentheses). With so
few rounds the mean carries run-to-run noise; treat differences under about 20% as noise.

| Entry point | Shape | 100 | 500 | 1,000 | 2,000 | 5,000 |
|---|---|---|---|---|---|---|
| `schedule()` | chain | 1.7 (1.5) | 13.2 (7.4) | 18.8 (16.1) | 34.4 (33.2) | 109.2 (86.2) |
| `schedule()` | mixed | 2.7 (2.6) | 12.5 (11.6) | 26.9 (23.9) | 52.5 (48.0) | 145.1 (128.8) |
| `monte_carlo(runs=1000)` | chain | 13.9 (13.6) | 78.5 (71.4) | 140.6 (124.7) | 231.6 (230.8) | 578.8 (569.2) |
| `monte_carlo(runs=1000)` | mixed | 7.5 (7.4) | 37.7 (37.6) | 75.5 (73.5) | 167.6 (160.3) | 393.3 (382.5) |

Nothing above 5,000 tasks and no incremental-recompute series has been measured yet. The
2,000-task `schedule()` target of under 1 s on the CI runner is recorded, not gated: the
`scheduler:post-test` job (its `scheduler:benchmarks` check) stores the benchmark JSON as an artifact on every run.

Reproduce:

```bash
pip install -e "packages/scheduler[dev]"
cd packages/scheduler
pytest tests/benchmarks/bench_engine.py --benchmark-only --benchmark-json=bench.json
```

## Status and roadmap

What the test suites check, and what they do not, is laid out in the
[scheduler conformance and verification](https://docs.trueppm.com/architecture/scheduler-conformance/)
page — the oracle coverage matrix, the shapes the reference refuses, and the fuzzing budgets.

**0.4 — the current release.** The CPM pass (all four dependency types,
calendar-day lag snapped to working days, cycle detection) and Monte Carlo simulation (PERT-Beta,
velocity sampling, `derive_value()` explainability) are stable and exercised
by the fuzz, mutation, and MS-Project-parity suites described in
[CONTRIBUTING.md](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/scheduler/CONTRIBUTING.md).

**Known limitations open against 0.4**, grouped by area — every item below is
an open issue; nothing in this list is fixed yet, regardless of which future
release it is scheduled for:

- **CPM correctness** — closing out-of-sequence work can still move a
  signed-off milestone's successors when several predecessors are late
  ([#4915](https://gitlab.com/trueppm/trueppm/-/issues/4915)); a calendar-day
  lag out of a milestone closed at the start of its day can count from an
  earlier equivalent midnight read from its completed predecessors, so a change
  to completed work can move its lagged successors later, never earlier
  ([#5089](https://gitlab.com/trueppm/trueppm/-/issues/5089)); closing a milestone ahead of an open predecessor still moves
  its lagged successors
  ([#4740](https://gitlab.com/trueppm/trueppm/-/issues/4740)), and which calendar anchors and snaps an FF/SF link across
  different calendars is still undecided
  ([#4639](https://gitlab.com/trueppm/trueppm/-/issues/4639)); and several
  MS-Project-parity cases — SF out of a milestone, mixed SF+FS/SS/FF at the
  project-start floor — remain unverified against a real MS Project export
  ([#4327](https://gitlab.com/trueppm/trueppm/-/issues/4327),
  [#4319](https://gitlab.com/trueppm/trueppm/-/issues/4319)). Progress and
  actuals: a 100%-complete task with an `actual_start` but no `actual_finish` is
  still laid out over its full span, so it can finish after the data date
  ([#5043](https://gitlab.com/trueppm/trueppm/-/issues/5043)). Moving the
  project start later can still move a floored milestone's successors earlier
  ([#5055](https://gitlab.com/trueppm/trueppm/-/issues/5055)). An FF/SF link
  into a parent with backlog, epic or recurring children can still be left
  unrecalculable by paths the API does not yet check (sprint close returning
  tasks to the backlog, task delete, program-wide recalculation, links from
  another project)
  ([#5046](https://gitlab.com/trueppm/trueppm/-/issues/5046)).
- **Monte Carlo** — sprint-horizon
  clamping truncates the slow tail of a velocity-driven P80/P95, so it reads
  as a lower bound rather than a full forecast. From 0.5 the result will report
  how many runs were clamped (`velocity_saturated_runs`), but the bias itself
  will not be removed
  ([#2469](https://gitlab.com/trueppm/trueppm/-/issues/2469)); a zero-duration task drawing real work back-solves through
  FF/SF, so the Monte Carlo P50 can land before the CPM date
  ([#4822](https://gitlab.com/trueppm/trueppm/-/issues/4822)); what-if changes the
  velocity draw layout, so seeded bands are not ordered by the pull-in
  ([#4910](https://gitlab.com/trueppm/trueppm/-/issues/4910)); a what-if pull-in can
  move a band later when a velocity task's points reach 0 and it falls to its PERT
  estimate
  ([#4909](https://gitlab.com/trueppm/trueppm/-/issues/4909)); Monte Carlo can
  finish before the CPM date when an FF/SF link pulls a scrum story's start
  earlier and an SS successor inherits it
  ([#5042](https://gitlab.com/trueppm/trueppm/-/issues/5042)); and one shared
  random stream couples unrelated tasks, so adding an estimate to one task
  changes another task's draws under the same seed
  ([#5020](https://gitlab.com/trueppm/trueppm/-/issues/5020)).
- **Scale / performance** — from 0.5 the engine will bound the longest dependency chain, not
  the task count, so a 100,000-task project of ordinary parallel work will schedule;
  only the total work ceiling (`MAX_PROJECT_WORK_DAYS`, see Project work above)
  will apply to it. In 0.4 the span guard sums every task's duration. Scale benchmarks above
  5,000 tasks are tracked with the task-envelope work
  ([#3825](https://gitlab.com/trueppm/trueppm/-/issues/3825)); from 0.5, Monte Carlo
  will run its forward pass over chunks of runs, and above 32M cells (runs × tasks)
  will replay the float64 sampled-duration matrix a row block at a time instead of
  holding it, with seeded results byte-identical. Measured at 50,000 tasks × 1,000
  runs: about 475 MB peak RSS (about 785 MB with the matrix held, 2.1 GB unchunked),
  at the price of a slower run, about 6 s to about 9 s, because each sampled column is
  drawn three times. A milestone's or zero-duration task's per-run instant will be
  held for those columns only, not for every task. The floor that remains is one
  forward chunk (8M cells, about 130 MB of start and finish offsets) plus the
  project's own graph; the under-250 MB target and `MC_TASK_CAP` are tracked in
  [#4953](https://gitlab.com/trueppm/trueppm/-/issues/4953).

**Committed for 0.5.** 0.5 will run a hardening pass over the engine
([#3988](https://gitlab.com/trueppm/trueppm/-/issues/3988)) rather than ship
new scheduling features; the following are `release::committed` for 0.5 —
they will ship with 0.5 or that release will slip:

- **Correctness hardening** — extending the
  independent CPM oracle to milestone late dates/floats
  ([#4275](https://gitlab.com/trueppm/trueppm/-/issues/4275)); mutation-testing
  phase 2 brings the engine itself into scope
  ([#2468](https://gitlab.com/trueppm/trueppm/-/issues/2468)).
- **Monte Carlo correctness** — the sprint-horizon clamp bug above will be
  fixed ([#2469](https://gitlab.com/trueppm/trueppm/-/issues/2469)), and so
  will the zero-duration back-solve that can put a Monte Carlo P50 before the
  CPM date ([#4822](https://gitlab.com/trueppm/trueppm/-/issues/4822)).
- **Progress and actuals correctness** — the CPM defects above that move a
  date, float, or percentile on a project with recorded actuals or a
  milestone: closing a milestone ahead of an open
  predecessor ([#4740](https://gitlab.com/trueppm/trueppm/-/issues/4740)).
- **Scheduling semantics** — the calendar-day-vs-working-day lag question will be
  decided ([#2535](https://gitlab.com/trueppm/trueppm/-/issues/2535));
  deadline-driven negative float will surface "behind committed date" in CPM
  output ([#804](https://gitlab.com/trueppm/trueppm/-/issues/804)); and
  partial resource allocation (e.g. someone at 60%) will be enforced in the
  CPM/leveling pass
  ([#84](https://gitlab.com/trueppm/trueppm/-/issues/84),
  [#744](https://gitlab.com/trueppm/trueppm/-/issues/744)).

May also land in 0.5, but not yet committed (reserve, stretch, or not yet
triaged): the remaining MS-Project-parity gaps
([#4327](https://gitlab.com/trueppm/trueppm/-/issues/4327),
[#4319](https://gitlab.com/trueppm/trueppm/-/issues/4319)).

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
