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
