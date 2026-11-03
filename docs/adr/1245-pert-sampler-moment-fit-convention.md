# ADR-1245: The PERT sampler is a Beta fitted to the classic PERT moments, not the λ=4 Beta-PERT

## Status

Accepted (2026-10-04)

> **Implementation status (2026-10-04, #4267):** this records behavior that already
> ships; nothing in the engine changes. The sampler is
> `packages/scheduler/src/trueppm_scheduler/engine.py::_sample_pert`, the user-facing
> statement is the Monte Carlo rows of `features/scheduler-conventions.md` (#4133), and
> the executable form of this decision is
> `packages/scheduler/tests/test_monte_carlo_distribution_oracle.py`.

## Context

P3M layer: **Projects** — the per-task duration distribution behind every Monte Carlo
forecast (P50/P80/P95). OSS; the engine ships in `trueppm-scheduler` (Apache 2.0).

A three-point estimate `(o, m, p)` does not determine a distribution. Two conventions
are in common use, and both are called "PERT-Beta":

1. **Classic PERT moments.** Malcolm, Roseboom, Clark & Fazar (1959), *Application of a
   Technique for Research and Development Program Evaluation*, Operations Research
   7(5):646–669, introduced the estimates `μ = (o + 4m + p) / 6` and
   `σ = (p − o) / 6`. A Beta on `[o, p]` can be fitted to exactly those two moments by
   method of moments.
2. **λ=4 Beta-PERT.** The form @RISK and Primavera Risk Analysis default to (Vose,
   *Risk Analysis: A Quantitative Guide*, 3rd ed., Wiley 2008):
   `α = 1 + 4(m − o)/(p − o)`, `β = 1 + 4(p − m)/(p − o)`, so `α + β = 6` for every
   task. Its mean is the same `μ`; its variance is `(μ − o)(p − μ) / 7`.

The engine has always used (1). Until now that choice was recorded only in the
`_sample_pert` docstring and a closed issue (#4133), and the distributional oracle
added in #3546 derived its expected values by reading the engine, not from a stated
specification. A test that takes its expected values from the code it checks will
pass a code change if someone updates the test to match. That is the gap this record
closes.

## Decision

`_sample_pert` samples `o + (p − o) · Beta(α, β)`, where `α` and `β` are solved so the
Beta has mean `(μ − o)/(p − o)` and variance `σ² / (p − o)²` exactly, with `μ` and `σ`
the classic PERT estimates above:

```
mu_n  = (mu - o) / (p - o)
var_n = ((p - o) / 6)**2 / (p - o)**2  = 1/36
kappa = mu_n * (1 - mu_n) / var_n - 1  = 36 * mu_n * (1 - mu_n) - 1
alpha = mu_n * kappa
beta  = (1 - mu_n) * kappa
```

Because `m ∈ [o, p]` puts `mu_n` in `[1/6, 5/6]`, `kappa ≥ 4` and both shape
parameters are always positive; the degenerate fallback in the code is reached only
for `o == p`.

The spec that tests assert against is therefore the two published closed forms: mean
`(o + 4m + p) / 6` and standard deviation `(p − o) / 6`. These numbers come from the
1959 paper, not from the engine.

## Consequences

**The spread differs from λ=4 in a direction that depends on the triple.** Closed form:

| Triple (o, m, p) | Engine σ | λ=4 σ | Engine / λ=4 |
|---|---|---|---|
| (2, 5, 8), symmetric | 1.000 | 1.134 | 0.88 |
| (1, 2, 10), right-skewed | 1.500 | 1.454 | 1.03 |
| (5, 5, 20), mode at optimistic | 2.500 | 2.113 | 1.18 |

On a symmetric estimate the band is about 12% tighter than λ=4, so P80 and P95 land
earlier. When the most-likely value sits at one end, the band is wider.

**The fitted mode is only approximately `m`.** Method of moments preserves the mean
and variance, not the mode. On a symmetric triple the mode is exactly `m`. On
(1, 2, 10) the fitted Beta's mode is about 1.86, not 2. When `m` sits at an end, `α`
or `β` falls below 1, so the density is unbounded at that end and the mode is the end
itself, which here equals `m`. λ=4 preserves `m` as the mode by construction. A
planner who reads "most likely" as "the mode of the sampled distribution" will see a
small mismatch on skewed estimates. Both conventions match the mean exactly.

**The engine's σ is the σ a planner computes by hand.** `(p − o) / 6` is the textbook
PERT standard deviation, and MS Project's PERT fields use the same classic mean
(ADR-0093). Under this convention the spread the engine samples is the one in the
textbook formula. λ=4 does not have this property: its variance depends on where `m`
sits.

**Switching conventions is a semantics change, not a bugfix.** Moving to λ=4 would
shift every seeded P50/P80/P95 and every persisted forecast-history comparison
(ADR-0175). It would need a superseding ADR, a changelog `changed` entry, release
notes, and an update to `features/scheduler-conventions.md`. The oracle test pins the
current convention against both closed forms and names this ADR in its failure
message, so such a change cannot land as a quiet test update.

## Alternatives considered

- **λ=4 Beta-PERT.** It is the risk-tool default and preserves the mode. It was not
  adopted because the engine shipped with the classic-moment fit, and changing it would
  move every customer's existing forecasts for a gain in convention-matching, not in
  correctness. Neither convention is more correct. Revisit if users importing from
  @RISK or Primavera Risk Analysis report percentile mismatches as a blocker. That
  would be real-user signal, which this record does not have.
- **Triangular distribution.** Rejected. Its tails are heavier than either Beta form,
  and practitioners do not read a three-point estimate this way.
- **A per-project convention setting.** Rejected for now. It doubles the oracle surface
  and puts a statistics choice in front of PMs who mostly do not know there is one.

## Percentile notes

**A percentile with no run at its position (#4691, 2026-10-31).** The P50/P80/P95
reading over the sampled runs is `numpy.percentile`'s linear interpolation over each
run's working-time finish position (`engine.py::_mc_percentiles`). Interpolation can
land between two occupied positions. When it does, the percentile is shown at the end
of the working day before that position, unless a run at a lower position is shown on
a later day. In that case it is shown on that run's day and edge.

The exception exists for per-task calendars. Mixed calendars are compared on a
reference ruler that is the union of every calendar's working days, so the ruler can
hold a day no task works, such as a Friday when every task is on a Monday-Thursday
week. Runs jump over that day. A start-of-day milestone that finishes at the end of
Thursday is shown at the start of Monday. Before #4691, a percentile that interpolated
onto the Friday was reported as the end of Friday: before P50, before every run in
`distribution`, and before the CPM finish. Each percentile is also clamped to at least
the one before it, so `p50 <= p80 <= p95` is an invariant of the reading, not a
consequence of its inputs.

Alternatives considered: nearest-rank (`method="higher"`) on positions, or the shown
day of the smallest run position at or above the percentile. Both fix the defect, but
both also move seeded percentiles on single-calendar projects wherever run positions
are sparse, such as velocity-sampled sprint jumps. The chosen rule is a no-op on a
single calendar, because there a run is shown at most one working day past its
position, so no run below the percentile is shown past it. This was checked against
1,200 seeded single-calendar forecasts, with no change. The sampler convention this
ADR records is unaffected.

## Amendment: a fractional finish is shown on the day it falls in (#4697, 2026-11-02)

**Context.** The engine schedules whole days, but `_sample_pert` returns continuous
durations, and the forward pass carries each run's offsets as continuous
working-time positions. The positions were mapped back to days by rounding to the
nearest integer, half to even (`round(offset) - 1` in `_offset_to_date`, `np.rint`
in `_mc_percentiles`, `_lag_term`, `_McIndex.ordinal_at` and
`_to_reference_offset`). Work ending 0.3 of the way into a day was therefore
reported, and ranked, as finishing the day before. On a 10-day task estimated
(10, 10, 11), P50 and P80 were the CPM finish although no run finished there, and
the forecast under-stated the simulated risk by a working day, more where lagged links each lost one.

**Decision: read each position by the day it falls in.** An exclusive finish `e` is
on day `ceil(e) - 1` and a start `s` on day `floor(s)`, each with a `1e-9` slack for
float noise (`_finish_day_key`, `_start_day_index`). A whole offset maps exactly as
the deterministic pass maps it, so a run with no spread still lands on the CPM
finish. Every place that turns a sampled offset into a day uses the same rule:

- The finish date and the percentile keys (`_offset_to_date`, `_mc_percentiles`)
  and the mixed-calendar reference ruler (`_to_reference_offset`).
- The anchor cell of a lagged link (`_lag_term`). FS/FF read the predecessor's
  finish, and SS/SF its start. The link carries the anchor's fraction while the
  lagged point lands in the successor's working time. When the point lands on a day
  the successor does not work, the successor starts when its next working day
  begins, with no fraction (`_lagged_constraint`). Carrying it there would start an
  FS successor before its lag on the snapped day.
- Milestones. The date space holds only midnights, so a milestone after work ending
  part-way into a day is placed at the midnight closing that day. It carries the
  working time it lies short of that midnight as a **deficit**. Its position, and
  every link out of it, measures from the true point (`_mc_milestone_bounds`,
  `_mc_instant_edge_bound`). Rounding milestones up to the midnight instead put each
  milestone on a path up to a day late, and the error compounded along a chain.
- Zero-duration tasks with an estimate (#4698) are **exempt**; see below.

**Exemption: a zero-base column keeps its CPM-instant semantics.** A zero-base column
is a live task whose base `duration` is zero but which samples a positive duration:
a three-point estimate such as (0, 0, 1), or story points on the velocity path
(`zero_base_ids` in `monte_carlo`). A plain milestone samples nothing and is
already an instant. A zero-base draw under half a day (`_ZERO_BASE_ROUND_AWAY`)
rounds away. The run is exactly the milestone `schedule()` places, links and lags
included, and it hands no fraction on to the work after it. That covers the
finish's fraction and also the start an FF or SF link back-solved over the draw. A
draw of half a day or more is ordinary work, so the task still matches a real task
of that length.

*Why the back-solved start is not kept.* A first version kept it for SS and SF
successors, on the reasoning that it could only move them earlier. Earlier than
CPM is the failure that reasoning missed. The start was added to the successor's
bound after that link's lag and snap, so it pulled the successor back across a
non-working landing, which `_lagged_constraint` deliberately does not do. In
`t0(3d) -FF-> M(0,0,1) -SS+3-> t2(5d) -SS+3-> t4(5d)`, M sits on Wednesday, its
SS+3 lands on Saturday, and t2 must start on Monday. The kept start put t2 0.7 into
Friday, and t2's own lag carried the fraction on to t4. P50 = P80 fell two days
before CPM, with 94.5% of runs early. An audit sweep of 576 FF/SF-in, SS/SF-out
cells found 33 with P50 off CPM, all earlier; with the start dropped there are none.
The other fix applies the start to the anchor before the lag and snap, so the
landing rule governs it. It was rejected because the start can lie more than a day
before the instant's midnight, which the deficit's one-day landing test cannot
represent. Dropping the start does not change how often FF/SF networks step
backward as a draw grows (28 of 1,336 networks, 43 steps, either way). It moves the
backward steps that remain to the half-day threshold, the #4822 back-solve class.
Without the kept start, no backward step falls inside the sub-half-day range.

The exemption exists because the base estimate is zero, so the instant is what the
plan says. A (0, 0, 1) Beta draw is never exactly zero (`alpha` is about 2/3). If
the task handed its fraction on, the day-it-falls-in reading would push every
whole-day successor into the next working day in every run. That would restore the
day of slip #4698 removed: the auditor's repro A(5d) → M(0, 0, 1) → B(5d) gave
P50 = P80 = P95 one day past CPM in 100% of runs, and a milestone at the end of a
path, A → M(0, 0, 1), was one day late in 100% of runs. #4698's acceptance
criterion, that (0, 0, 1) gives P50 equal to CPM, is pinned by
`test_a_small_estimate_does_not_cost_a_day`. With the exemption, 5.2% of runs land
after CPM, matching the pre-#4697 engine. The cost of the exemption is that sub-half-day draws in a chain cost nothing
together: three 0.2-day draws are three instants, although they add up to 0.6 of a
day of work, which #4698 had carried.

**Alternative rejected: round each sampled duration up to whole days at sampling
time.** That alternative keeps every offset whole, so no other rounding site would
need to change, and it also keeps a zero-variance run on CPM. But it charges each
task the unused rest of its last day. On a chain this adds about half a day per
task. Three tasks estimated (5, 5, 6) simulate about 15.5 days of work, and
rounding each one up reports 18 days in every run, where the day-the-work-falls-in
reading reports 16. The rejected rule moves the error from under-stating the
finish to over-stating it, and the over-statement grows with path length. It also
discards the fraction that this record's sampler convention and the reference
ruler (`_to_reference_offset`) carry deliberately.

**Consequences.**

- **Seeded percentiles move.** Measured over 1,000 seeded random networks of each
  kind (seeds 40000–40999), against the merge-base engine:
  - FS/SS-only networks: 930 of 1,000 changed. No percentile landed before the
    CPM finish. Most moved one working day later, and lagged links moved some up
    to four working days later, because the nearest-day reading could lose a day
    at each lagged link. Two networks had a percentile one working day earlier: the
    same reading could also add a day at a lagged link. An earlier 1,000-seed audit
    run found 5.
  - Networks with FF or SF links: a percentile can also move earlier (5 of 1,000,
    by up to three working days), and three networks had a percentile before CPM.
    CPM itself is non-monotone there (#3806).
  - Zero-variance runs matched CPM in all 1,000 sampled networks.

  Persisted forecast history (ADR-0175) shows a one-time step at the upgrade. That
  step is a change of reading, not a change of risk.
- An interpolated percentile that falls strictly between two whole-day positions is
  read on the later day, because that is the day the interpolated position falls
  in. Exact midpoints used to round half to even. #4540 tracks the tie and low-N
  conventions and should take this as its new baseline.
- SF and FF links carry the start's or finish's fraction without the landing test.
  An FF bound only moves within its snapped day. An SF bound whose lagged point
  lands in non-working time can read up to a day late. That is a conservative
  approximation and never reads early.
- `packages/wasm-scheduler` has no Monte Carlo path, so conformance is unaffected.
