# ADR-1412: Velocity forecasting draws one shared team capacity per Monte Carlo run

- **Status:** Accepted (2026-11-15; shared-capacity model chosen by the user)
- **Date:** 2026-11-15
- **Issues:** #5011 (model), #5012 (progress on a velocity task), #5013 (silent fallback)
- **Related:** #411 (agile-aware Monte Carlo), #2469 (sprint-horizon clamp), #3765 (the plan is the floor), #4529 (sprints on a per-task calendar), #4694 (sampler memory), #5008 (the API's own velocity sampler), #953 (velocity in the API input pipeline)

## Context

Since #411 a `DeliveryMode.SCRUM` task with `story_points` has sampled its Monte Carlo
duration from the project's `velocity_samples`. Each task did it alone: its own bootstrap
of the **whole** team's per-sprint throughput, counted up to a **whole** number of
sprints. Both halves were wrong for any project with more than one story (#5011). With a
team that delivers exactly 20 points a sprint and 10-working-day sprints:

| Case | Per-task model (0.4) | Throughput says |
|---|---|---|
| 10 sequential 2-point stories | 100 working days | 10 working days |
| 5 parallel 20-point stories | one sprint | five sprints |

Draws were also independent across tasks, so one bad sprint hit one story, and the band
was too narrow. Progress was measured in the wrong unit (#5012): the sampler drew the
**full** `story_points`, and the elapsed days `int(duration * pct / 100)` were then
subtracted from a span that has no relation to `duration`, so 50% complete forecast the
same as 0%. And the path could be switched off silently (#5013).

## Decision

### 1. One capacity vector per run, shared by every velocity task

Each run draws one per-sprint velocity vector, bootstrapped with replacement from the
usable observations of `velocity_samples`. Sprint `k` opens `k * sprint_length_days`
working days of the **project** calendar after the sprint origin, the data date
(`status_date`, else `start_date`) snapped to a working day, and delivers its drawn
points evenly over its working days.

Every live SCRUM task with positive remaining points claims those points from that
vector. Its finish is the fractional instant at which its last point is delivered, so a
story that needs a fifth of a sprint takes a fifth of a sprint: **no whole-sprint
rounding per task**. Sequential stories consume capacity one after another; parallel
stories compete for the same sprints. Because every story in a run reads the same
vector, a slow sprint delays everything in flight and the band widens as it should.

### 2. Allocation order

Velocity tasks claim capacity in the Monte Carlo forward pass's column order: the
lexicographic topological order (predecessors first, otherwise by task id). That order
is deterministic, independent of task insertion order, and already fixes the RNG stream; a separate "earliest start first" order would need a per-run sort and could not
be vectorized across runs. Within a run:

- A task becomes ready at the early start its constraints give it: its predecessors,
  scrum or not, lags, `planned_start`, the data date and any recorded start. Capacity
  before that instant is not spent on it. A non-scrum predecessor therefore delays a
  story exactly as it delays any task, and a non-scrum successor starts from the
  story's capacity-driven finish.
- Capacity within a sprint is claimed front to back. A story ready mid-sprint cannot use
  the part of that sprint already behind it, and a story allocated later cannot
  back-fill a gap an earlier allocation skipped. Both only ever make a finish later.
- When two independent stories are ready in the same sprint, the one earlier in the
  order is served first. The project finish does not depend on which one that is when
  both lead to it, only per-task dates do.
- An FF/SF constraint that moves a story's start after its claim leaves the claim where
  it was; the capacity is read at the start its predecessors allow.

### 3. Remaining points, no elapsed-day subtraction (#5012)

A velocity task needs `story_points * (1 - percent_complete / 100)` points. Elapsed days
read off `duration` are **not** subtracted on this path. The forecast is therefore
non-increasing in `percent_complete` for a fixed seed and data date, and a 99% story
needs a hundredth of its points. `duration` less its elapsed days stays a floor on the
claimed duration (#3765), so on a network of FS and SS links Monte Carlo does not land
before `schedule()`. It can in a known class: an FF/SF link that pulls a story's start
earlier, with an SS successor inheriting it, and (already on main) for large stories
(#5042). The progress rows 0%, 50% and 99% of #5012 forecast equal dates at 0% and 50%
because the data date moves with progress; at a fixed data date the forecast shrinks.
`perturb_task_duration` moves the remaining points by `delta_days` at the mean pace, so
the #4820 whole-sprint exhaustion ceiling is no longer needed and is removed.

### 4. Horizon and the #2469 clamp

The drawn capacity spans `ceil(remaining backlog / mean velocity) * 4 + 10` sprints, the
old per-task horizon applied to the whole backlog, plus the sprints that can pass before
the last story is ready (the working days from the sprint origin to where the Monte Carlo
horizon walk ends with no velocity term), capped at `MAX_VELOCITY_SPRINTS` and inside
`MAX_PROJECT_SPAN_DAYS`. A run that has not burned a story down when the capacity ends
clamps that story's finish at the capacity end and is counted in
`velocity_saturated_runs`, as before. The Monte Carlo index walk raises every velocity
task's bound to the capacity end instead of charging each one its own worst case along
its chain, which keeps the index bounded for long chains of small stories (#4695).

### 5. Fallback is reported, and a non-positive sprint is refused (#5013)

The deterministic fallback stays, but `MonteCarloResult.velocity_fallback_reasons` (a
tuple of strings, also in `to_dict()`) says why a supplied history was not used:
`"sprint_length_days_missing"` or `"velocity_history_unusable"` (no usable observation,
or a non-positive mean). It is empty when the history was used, when none was given, or
when no SCRUM task carries points. `sprint_length_days <= 0` is refused with
`InvalidScheduleInput` by `Project.from_dict`, `schedule()` and `monte_carlo()`.

### 6. Determinism and memory

Capacity is drawn after every per-task column, so a project without velocity consumes
the seeded stream exactly as before. The `(runs, sprints)` matrix never exists whole: the
stream yields one seed per block of runs (block size a function of the horizon alone),
and each forward-pass chunk draws its blocks from those seeds. A fixed seed therefore
gives identical results, chunked and unchunked runs are bit-identical, and the
10,000-sprint horizon stays under the 100 MB bound #4694 pins.

## Consequences

- Every seeded velocity forecast moves. Small sequential stories finish much earlier;
  parallel stories finish later; bands widen. This is the intended correction, recorded
  as a changed behavior for 0.5.
- The tornado ranks a velocity task by its realized (claimed) duration per run.
- Capacity is modeled in project-calendar working days. A story on its own per-task
  calendar has its start and finish mapped through calendar dates (#4529), so it keeps
  the sprint span's dates; that mapping is exact for a whole day and approximate inside a
  day.
- Hybrid velocity forecasting is marked **experimental** in the README and on the
  website until the model has been checked against real projects.
- Monte Carlo can land before `schedule()` behind an FF/SF link (#5042); the floor holds
  for FS and SS networks only.
- `_sample_velocity_durations` (the per-task primitive) is no longer called by
  `monte_carlo()`. It stays because the API's sprint-forecast sampler is held to it by
  `packages/api/tests/apps/projects/test_velocity_sampler_conformance.py`.

## The API must adopt this model (#5008)

#5008 moves the API's own velocity/throughput bootstrap into the scheduler. That move
must adopt this model (one capacity per run, fractional sprints, remaining points), not
the per-task primitive, or the sprint-forecast surface and the Monte Carlo forecast will
disagree about the same team.

The library half of that move, `trueppm_scheduler.forecast` (#5008), first shipped
counting whole sprints with a copy of the per-task primitive, so for one backlog,
history and seed `forecast_velocity_delivery()` and `monte_carlo()` returned different
dates (#5185). It now holds no velocity sampler of its own: `forecast_velocity_delivery`
runs `monte_carlo()` on a one-story SCRUM project (a one-day `duration` floor, a
seven-day working week, `today` as start and data date) and returns its P50/P80/P95
dates, so the two agree by construction. `tests/test_forecast.py` pins the parity
against an independently built `monte_carlo()` call. The throughput forecast has no
Monte Carlo counterpart and keeps its own bootstrap. API call sites found on 2026-11-15, unchanged by this ADR:

- `packages/api/src/trueppm_api/apps/projects/services.py`: the bootstrap sampler near
  line 5706 (documented as matching `_sample_velocity_durations` at
  `sprint_length_days=1`), `_typical_sprint_length_days` (~5626), its use at ~5831, and
  `scheduler_velocity_inputs` (~888-940), which builds `velocity_samples` and
  `sprint_length_days` for the engine (always `>= 1`).
- `packages/api/src/trueppm_api/apps/scheduling/views.py`: the three
  `scheduler_velocity_inputs(...)` callers that pass `velocity_samples` /
  `sprint_length_days` into `Project` (~954-981, ~1649-1674, ~2758-2773), and the
  `forecast_diagnostic(has_velocity_signal=...)` call (~1067).
- `packages/api/src/trueppm_api/apps/scheduling/serializers.py`:
  `velocity_saturated_runs` and, from this change, `velocity_fallback_reasons` on the
  Monte Carlo response (the view spreads `MonteCarloResult.to_dict()`).
- `packages/api/src/trueppm_api/apps/projects/project_templates.py` and
  `bundled_templates.py`: carry `sprint_length_days` on templates.
