---
title: Monte Carlo
description: Convert three-point task estimates into a probability distribution over the project finish date — P50, P80, and P95 with the full distribution curve.
---

TruePPM's Monte Carlo simulation converts three-point task estimates into a
probability distribution over the project finish date. Rather than a single
deterministic finish from CPM, you get P50, P80, and P95 dates alongside the
full distribution curve — a complete answer to "what is the chance we finish by
date X?"

:::note[Edition]
Monte Carlo is part of the **Community (OSS)** edition. The simulation runs in
the standalone [`trueppm-scheduler`](/features/scheduler/) engine
(vectorized NumPy), so it has no Django dependency.
:::

This capability is rare in open-source P3M tools. The sections below document
exactly how it works so you can trust the numbers and explain them to
stakeholders.

## How to use it

### Step 1 — Add three-point estimates to tasks

Open any task's detail drawer and navigate to the **Estimates** section. Set all
three values (working days):

| Field | Meaning |
|---|---|
| **Optimistic (O)** | Duration if everything goes well — no blockers, best-case execution |
| **Most Likely (M)** | Your honest expected duration under normal conditions |
| **Pessimistic (P)** | Duration if significant problems occur — realistic tail risk, not fantasy |

All three fields must be set for a waterfall task to be sampled from its
three-point estimate. A waterfall task with any of the three missing is treated
as having zero duration uncertainty: its deterministic `duration` is used for
every simulation run.

**Agile (Scrum) tasks are the exception** — a task delivered as sprint work
draws its uncertainty from team velocity rather than a three-point estimate, so
it does not need O/M/P values set. See
[Agile tasks: velocity-based sampling](#agile-tasks-velocity-based-sampling)
below.

**Focus your effort on critical path tasks.** Tasks with float do not drive the
finish date; uncertainty in their durations has little effect on the output.

### Step 2 — Run the simulation

```
POST /api/v1/projects/<project_id>/monte-carlo/
Content-Type: application/json

{ "n_simulations": 1000 }
```

The `n_simulations` field is optional; it defaults to the server's
`MC_SIMULATION_CAP` setting (1,000 on OSS, unlimited on Enterprise). The
endpoint is synchronous and fast — under 100 ms for a 200-task project at 10,000
runs.

The endpoint also enforces a **task cap** (`MC_TASK_CAP`, 5,000 on OSS): a project
with more tasks than the cap returns HTTP 402 rather than running an unbounded
simulation. The vectorized engine handles a 5,000-task × 1,000-run simulation in a
few seconds; operators on constrained hardware can lower the cap, and Enterprise
removes it.

### Step 3 — Read the output

```json
{
  "project_id": "...",
  "runs": 1000,
  "p50": "2025-11-14",
  "p80": "2025-12-02",
  "p95": "2026-01-08",
  "distribution": ["2025-10-21", "2025-10-22", "..."]
}
```

| Field | Meaning |
|---|---|
| `p50` | 50% of simulated runs finished on or before this date. Closest to the deterministic CPM date. |
| `p80` | 80% of runs finished by this date. The standard commitment date for most project plans. |
| `p95` | 95% of runs finished by this date. Use for contractual deadlines and hard external commitments. |
| `distribution` | Full sorted list of all simulated finish dates. Use this to render a histogram or answer "what is the probability of finishing by date X?" |

The most recent result is also available without re-running the simulation:

```
GET /api/v1/projects/<project_id>/monte-carlo/latest/
```

## Forecast history

A single percentile date answers "when?" once. The more useful planning question
is "is my confidence eroding?" — has the P80 finish slipped since you last looked?

**As of 0.3** (ADR-0175), TruePPM persists project-level Monte
Carlo runs so you can read finish-date *drift* over time: "my P80 was Aug 14 two
weeks ago, now it's Aug 28." Each recorded run carries its P50/P80/P95 as of that
moment, so the history is a true before/after, not just the latest snapshot.

From **0.4**, a run is recorded only when it is triggered by a **Scheduler** or
above — the members who own the schedule. Everyone from Viewer up can still run
the forecast and read the result and the drift history; their runs simply do not
add a history row. This keeps the drift timeline a signal about deliberate
re-planning rather than a log of every incidental read, and prevents a
low-privilege member from flooding the history or skewing run attribution.

The history will be available at:

```
GET /api/v1/projects/<project_id>/monte-carlo/history/
```

It will return persisted runs newest-first. Each run carries:

| Field | Meaning |
|---|---|
| `taken_at` | When the simulation was run (ISO 8601). |
| `p50` / `p80` / `p95` | The percentile finish dates as of that run. |
| `cpm_finish` | The deterministic CPM spine at run time, for context. |
| `n_simulations` | Number of runs in that simulation. |
| `task_count` | Committed tasks included in that simulation. |
| `delta` | Per-percentile signed day change versus the immediately previous run (positive = the forecast slipped later). `null` on the oldest/baseline run. |
| `triggered_by_name` | Who ran the simulation — see the visibility note below. |

In the UI, the Monte Carlo drawer (and the mobile bottom sheet) will gain a
collapsible **Forecast history** list showing each run with its per-run delta
(for example, `P80 ▲ +14d`), so the drift is legible at a glance.

The latest-result endpoint (`GET .../monte-carlo/latest/`) will also fall back to
this persisted history once the 24-hour cache has expired, so your most recent
forecast survives past the cache rather than disappearing.

:::note[Attribution is Admin/Owner only]
`triggered_by_name` will be returned **only** to project Admins and Owners. Every
other member (Viewer and up) will see the drift values without the run-author
name. This is deliberate: forecast drift is a planning signal about the *project*,
not a performance signal about a *person*.
:::

Forecast history is **Community (OSS)** edition and single-project scope. Rolling
forecast drift up *across* programs or a portfolio is out of scope here and
belongs to the Enterprise edition.

### Retention

Consistent with the OSS cap philosophy (`MC_SIMULATION_CAP`, `MC_TASK_CAP`), OSS
will keep the **newest 100 runs per project** (`MC_HISTORY_CAP`); a nightly job
trims older runs. Enterprise sets the cap to `None` (unlimited history). 100 runs
is ample to read multi-month drift on an actively re-forecast project.

## What-if analysis

Forecast history answers "is my confidence eroding?" over time. The other planning
question is forward-looking: "*if* this task slips a week, where does the whole
forecast land?" — without actually changing the plan to find out.

**Coming in 0.4** (#993), a non-mutating what-if endpoint will answer exactly that.
Point it at one task, give it a duration change, and it will recompute CPM and Monte
Carlo **in memory** and hand back the perturbed forecast — persisting nothing, so it
is safe to call as many times as you like:

```
GET /api/v1/projects/<project_id>/monte-carlo/whatif/?task_id=<task_id>&duration_delta=5
```

Supply exactly one of:

| Parameter | Meaning |
|---|---|
| `duration_delta` | Signed day offset applied to the task's current duration (`5` slips it a week later, `-2` pulls it in). |
| `new_duration` | Absolute day count to set the task's duration to (`>= 0`). |

An optional `n_simulations` controls the iteration count (default and cap are the
same `MC_SIMULATION_CAP` as a normal run). The response will carry:

| Field | Meaning |
|---|---|
| `current` | The unperturbed forecast — `p50`/`p80`/`p95`, `cpm_finish`, and the `critical_path` (task IDs). |
| `whatif` | The same fields recomputed with your perturbation applied. |
| `critical_path_changed` | `true` when the perturbation moved which tasks are on the critical path. |
| `delta_vs_current` | Per-field signed calendar-day shift (`p50`/`p80`/`p95`/`cpm_finish`); positive = later/worse. |
| `applied` | The resolved perturbation (`base_duration_days`, `duration_delta_days`, `new_duration_days`). |

Both forecasts sample with the same fixed RNG seed, so the delta isolates the effect
of your change rather than run-to-run noise, and the same query always returns the
same answer.

This is the endpoint behind the MCP `whatif` read tool: because it is a pure,
side-effect-free `GET`, an AI client with a read-only token can ask "what happens to
the Apollo forecast if design review slips two weeks?" and the CPM/Monte Carlo engine
— not the model — computes the answer, server-side, on your own instance.

What-if analysis is **Community (OSS)** edition and single-project scope. Cross-program
what-if belongs to the Enterprise edition.

## Progress-aware forecasting

:::note[Added in 0.3]
Progress-aware forecasting was added in the **0.3** release, available since the
`0.3.0-alpha.1` pre-release (Jun 28, 2026).
:::

As of 0.3 the forecast accounts for what is already done rather than
re-simulating the project from its original start date every run. As work
progresses, the simulation will:

- **Pin completed tasks** to their recorded actual finish dates instead of
  re-rolling their durations — finished work is a fact, not a probability.
- **Sample only the remaining duration** of in-progress tasks. A task that is
  60% complete contributes the uncertainty of its last 40%, not its whole
  estimate.
- **Anchor remaining work at a data date.** Not-started and remaining work will
  be scheduled no earlier than the project's **status date**, so the forecast
  never places future work in the past.

A new optional `status_date` field on the project (`GET`/`PATCH
/api/v1/projects/<id>/`) will set that anchor. When it is left null the forecast
defaults to today, so an actively-tracked project reads correctly with no extra
configuration; a PM who wants a reproducible, frozen forecast for a report can
pin an explicit date. The same progress signals will flow through the
deterministic CPM schedule, so the Gantt bars and the Monte Carlo band stay
consistent.

## The math

### PERT-Beta distribution

Each task's duration is sampled from a **PERT-Beta distribution**, a standard
technique for converting three-point estimates into a probability distribution.
PERT is preferred over a triangular distribution because it gives more weight to
the most-likely estimate, producing more realistic samples for human-estimated
tasks.

The PERT mean and standard deviation are:

```
μ = (O + 4·M + P) / 6
σ = (P − O) / 6
```

The 4× weight on M is what makes PERT more conservative than a triangular
distribution: the most-likely estimate pulls the mean strongly toward the
center.

Note that σ is one-sixth of the full range. A task with O = 3, M = 10, P = 17
(a 14-day spread) has σ ≈ 2.3 days. This is by design — PERT encodes the
assumption that extreme outcomes are genuinely unlikely.

### Beta parameterization

The PERT distribution is a Beta distribution scaled to the interval `[O, P]`.
Parameters α and β are derived by method-of-moments from the PERT mean and
variance:

```
μ_norm  = (μ − O) / (P − O)         # normalize mean to [0, 1]
var_norm = σ² / (P − O)²            # normalize variance
κ       = μ_norm · (1 − μ_norm) / var_norm − 1
α       = μ_norm · κ
β       = (1 − μ_norm) · κ
```

Samples are drawn from `Beta(α, β)` and then scaled back to `[O, P]`:

```
duration_sample = O + Beta(α, β) · (P − O)
```

For the symmetric example O = 3, M = 10, P = 17, this produces `Beta(4, 4)` —
a unimodal distribution centered at 10 days whose standard deviation in the
scaled domain is exactly `(P − O) / 6 = 2.33 days`. The PERT approximation is
exact for symmetric inputs.

### Agile tasks: velocity-based sampling

A task delivered as Scrum work — `delivery_mode = scrum` with committed
`story_points` — has no meaningful three-point *duration* estimate; its
uncertainty comes from how much the team completes each sprint. For these tasks
the simulation samples **sprints-to-completion** from the team's velocity
distribution instead of a PERT curve:

1. The completed-points totals from the team's last eight closed sprints
   (excluding any sprint flagged *exclude from velocity*) form the velocity
   sample set.
2. Each run bootstraps that set with replacement, accumulating points sprint by
   sprint until the task's `story_points` are burned down.
3. The number of sprints that took, multiplied by the team's typical sprint
   length (converted to working days), is the task's sampled duration for that
   run.

A faster team (high-throughput draws) finishes in fewer sprints; the slow tail
needs more — so the spread reflects real velocity variability, the dominant
source of schedule risk on agile work. This path takes precedence over a
three-point estimate: a Scrum task that also carries O/M/P values still samples
from velocity, because the delivery mode is an explicit declaration that
uncertainty comes from throughput, not a duration guess.

A project with no usable velocity signal — no closed, velocity-eligible sprint
with recorded completed points — falls back to each task's deterministic
`duration`, exactly as a waterfall task with no estimate does. So an agile
project with no sprint history yet still simulates (to a single deterministic
date) rather than failing.

Degenerate cases are handled explicitly:

- If `P − O < 1e-9` (zero spread), all samples equal M.
- If the computed α or β is ≤ 0 (numerically degenerate input), all samples
  equal M.

### CPM forward pass

The simulation pre-computes an `(n_runs × n_tasks)` duration matrix — all
sampled durations for all runs — using vectorized NumPy operations. It then
evaluates the CPM forward pass `n_runs` times in parallel, respecting all four
dependency types (FS, FF, SS, SF) and lead/lag offsets. Working-day calendars
are applied when converting numeric offsets back to finish dates.

Project finish for each run is `max(early_finish)` across all tasks. The full
set of simulated finish dates is sorted to produce the percentile output.

At 10,000 runs on a 200-task project, the full simulation completes in under
100 ms on commodity hardware (Apple M-series or equivalent x86-64).

### Why the Central Limit Theorem compresses your spread

When the critical path has many tasks, the project finish date is the sum of
many sampled durations. By the Central Limit Theorem, the standard deviation of
that sum grows as `√n · σ_task`, but the *coefficient of variation* (spread
relative to the mean) shrinks as `σ_task / (√n · μ_task)`. With ten tasks on
the critical path each having σ = 2 days, the project-level σ is only
`√10 · 2 ≈ 6.3 days` — much less than the 20 days you might naively expect
from adding up individual ranges.

This is not a flaw. It reflects the real statistical property of summed
uncertainty: diversification reduces relative risk. The implication is that
P80/P95 divergence from P50 grows slowly with critical path length and is driven
primarily by how genuinely pessimistic your P estimates are.

## Known constraints

### Statistical precision at low run counts

At 1,000 runs (OSS default), the P95 estimate is based on the top 50
samples. The binomial standard error on a P95 estimate at this sample size is
roughly ±1.4 percentage points, meaning your "P95" line could realistically
represent anywhere from P93 to P97. P80 is more stable (200 samples in the
tail), and P50 is very stable (500 samples on each side).

For planning conversations where the tail matters, the Enterprise edition's
higher run cap produces meaningfully more stable P80 and P95 estimates.

| Edition | Max runs | P50 stability | P80 stability | P95 stability |
|---|---|---|---|---|
| Community (OSS) | 1,000 | Good | Acceptable | Noisy (±1.4 pp) |
| Enterprise | Unlimited | Good | Good | Good at 10,000+ |

### Task durations are sampled independently

Each task's duration is sampled independently of every other task. In practice,
risks are often correlated: a vendor delay, a key person out sick, or a weather
event affects multiple tasks simultaneously. The simulation cannot model these
shared risk factors, and independent sampling therefore underestimates tail risk
in projects with strong correlated uncertainty.

**Mitigation:** If you know that several critical-path tasks share a common risk
driver, widen their pessimistic estimates to reflect the scenario where that
driver fires across all of them. This is a manual proxy for correlation, not a
true joint distribution, but it moves the tail in the right direction.

### No resource constraints

The CPM forward pass assumes unlimited resources: two tasks that are both
earliest-feasible on the same calendar day are treated as fully parallel. If
your project has a bottlenecked resource — a single specialist assigned to
sequential critical-path tasks — the simulation will produce dates that are
optimistic relative to the resource-leveled schedule.

**Mitigation:** Ensure your `duration` and three-point estimates reflect
realistic resource availability, not theoretical parallel execution. If you have
a resource-leveled CPM baseline, use its task durations as your M values.

### P estimates must be genuinely pessimistic

A common mistake is setting P = M × 1.2 (20% contingency). PERT with σ = (P −
O) / 6 means a P that is only slightly above M produces a very narrow
distribution. The P estimate should represent a realistic bad scenario — a
dependency that slips, an approval that takes twice as long, a technical problem
that requires a rework cycle — not just a scheduling buffer.

A well-calibrated three-point estimate typically has P at 2–4× the O value,
not 1.2× M.

## OSS edition limits

| Limit | OSS default | Enterprise |
|---|---|---|
| Max runs per request (`MC_SIMULATION_CAP`) | 1,000 | Unlimited |
| Max tasks per project (`MC_TASK_CAP`) | 5,000 | Unlimited |
| Max run history per project (`MC_HISTORY_CAP`, added in 0.3) | 100 | Unlimited |

Both settings can be changed in `settings/base.py` (or a local override). The
Enterprise package sets both to `None` (unlimited) in its settings include.
Self-hosted OSS operators may set any integer or `None` in their local
settings — the cap is advisory, not license-enforced.

Exceeding either cap returns HTTP 402 with a structured error body:

```json
{
  "error": "simulation_cap_exceeded",
  "tier": "team",
  "message": "Simulation count exceeds the community-edition cap."
}
```

## Interpreting results

**Use P50 as your baseline.** P50 is close to the deterministic CPM finish date.
The gap between deterministic CPM and P50 is small and usually reflects the
slight asymmetry in PERT distributions (a long right tail from pessimistic
scenarios pulling the mean above the mode).

**Use P80 as your commitment date.** An 80th-percentile date is the standard
for internal and stakeholder commitments in project management practice. It means
you have a 4-in-5 chance of finishing on or before that date given your
estimates.

**Use P95 for hard external commitments.** Contractual deadlines, public launch
dates, and regulatory submissions warrant a 95th-percentile buffer. At OSS run
counts the P95 value is noisy; run at the Enterprise edition's higher cap for
meaningful precision.

**Do not commit to P50.** A P50 date has a 50% probability of being missed by
definition. Committing to it is equivalent to flipping a coin on every project.

**Read the distribution, not just the percentiles.** The `distribution` field
contains every simulated finish date. A bimodal distribution — two clusters of
simulated dates — usually signals that one or two tasks have extreme P estimates
that dominate the tail. Investigate those tasks; they are your primary risk
drivers.

### Why is my forecast a single flat date?

When `P50`, `P80`, and `P95` are identical, the simulation found no uncertainty to
model — every run finished on the same day. This is correct when no committed task
can vary the finish, but the cause is not always "missing estimates". The result's
`forecast_diagnostic` field reports the reason, and the schedule view shows it in place
of the distribution:

- **Estimates awaiting approval** — in Suggest & Approve estimation mode,
  three-point estimates do not feed the forecast until a Scheduler approves them
  (`estimate_status = accepted`). The estimates are visible on the tasks, but the
  forecast treats them as not-yet-trusted. Approve them to fold their range in.
- **No estimate ranges** — tasks carry only a single duration (or a degenerate
  range where optimistic = pessimistic). Add genuine optimistic/most-likely/
  pessimistic estimates to the tasks you are unsure about.
- **Agile work with no velocity history** — story-point (Scrum) tasks sample from
  the team's completed-sprint velocity rather than a duration range. Until at least
  one sprint has closed there is no distribution to draw from. Close a sprint and
  re-run.
- **Estimated work off the critical path** — your estimates vary, but the longest
  path runs through fixed-duration work, so the variance never reaches the finish.
  Estimate the tasks that actually drive the date (see *What's holding the date*).
- **All work complete, or nothing committed** — finished tasks have no remaining
  work to vary, and backlog cards are excluded from the forecast entirely.
