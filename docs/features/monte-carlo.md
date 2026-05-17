# Monte Carlo probabilistic scheduling

TruePPM's Monte Carlo simulation converts three-point task estimates into a
probability distribution over the project finish date. Rather than a single
deterministic finish from CPM, you get P50, P80, and P95 dates alongside the
full distribution curve — a complete answer to "what is the chance we finish by
date X?"

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

All three fields must be set for a task to be included in the stochastic
simulation. A task with any of the three missing is treated as having zero
uncertainty: its deterministic `duration` is used for every simulation run.

**Focus your effort on critical path tasks.** Tasks with float do not drive the
finish date; uncertainty in their durations has little effect on the output.

### Step 2 — Run the simulation

```
POST /api/v1/projects/<project_id>/monte-carlo/
Content-Type: application/json

{ "n_simulations": 1000 }
```

The `n_simulations` field is optional; it defaults to the server's
`MC_SIMULATION_CAP` setting (1 000 on OSS, configurable on Team tier). The
endpoint is synchronous and fast — under 100 ms for a 200-task project at 10 000
runs.

### Step 3 — Read the output

```json
{
  "project_id": "...",
  "runs": 1000,
  "p50": "2025-11-14",
  "p80": "2025-12-02",
  "p95": "2026-01-08",
  "distribution": ["2025-10-21", "2025-10-22", ...]
}
```

| Field | Meaning |
|---|---|
| `p50` | 50% of simulated runs finished on or before this date. Closest to the deterministic CPM date. |
| `p80` | 80% of runs finished by this date. The standard commitment date for most project plans. |
| `p95` | 95% of runs finished by this date. Use for contractual deadlines and hard external commitments. |
| `distribution` | Full sorted list of all simulated finish dates. Use this to render a histogram or answer "what is the probability of finishing by date X?" |

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

### Beta parameterisation

The PERT distribution is a Beta distribution scaled to the interval `[O, P]`.
Parameters α and β are derived by method-of-moments from the PERT mean and
variance:

```
μ_norm  = (μ − O) / (P − O)         # normalise mean to [0, 1]
var_norm = σ² / (P − O)²            # normalise variance
κ       = μ_norm · (1 − μ_norm) / var_norm − 1
α       = μ_norm · κ
β       = (1 − μ_norm) · κ
```

Samples are drawn from `Beta(α, β)` and then scaled back to `[O, P]`:

```
duration_sample = O + Beta(α, β) · (P − O)
```

For the symmetric example O = 3, M = 10, P = 17, this produces `Beta(4, 4)` —
a unimodal distribution centred at 10 days whose standard deviation in the
scaled domain is exactly `(P − O) / 6 = 2.33 days`. The PERT approximation is
exact for symmetric inputs.

Degenerate cases are handled explicitly:

- If `P − O < 1e-9` (zero spread), all samples equal M.
- If the computed α or β is ≤ 0 (numerically degenerate input), all samples
  equal M.

### CPM forward pass

The simulation pre-computes an `(n_runs × n_tasks)` duration matrix — all
sampled durations for all runs — using vectorised NumPy operations. It then
evaluates the CPM forward pass `n_runs` times in parallel, respecting all four
dependency types (FS, FF, SS, SF) and lead/lag offsets. Working-day calendars
are applied when converting numeric offsets back to finish dates.

Project finish for each run is `max(early_finish)` across all tasks. The full
set of simulated finish dates is sorted to produce the percentile output.

At 10 000 runs on a 200-task project, the full simulation completes in under
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

At 1 000 runs (OSS tier default), the P95 estimate is based on the top 50
samples. The binomial standard error on a P95 estimate at this sample size is
roughly ±1.4 percentage points, meaning your "P95" line could realistically
represent anywhere from P93 to P97. P80 is more stable (200 samples in the
tail), and P50 is very stable (500 samples on each side).

For planning conversations where the tail matters, Team tier's higher run cap
produces meaningfully more stable P80 and P95 estimates.

| Tier | Max runs | P50 stability | P80 stability | P95 stability |
|---|---|---|---|---|
| OSS | 1 000 | Good | Acceptable | Noisy (±1.4 pp) |
| Team | Unlimited | Good | Good | Good at 10 000+ |

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
optimistic relative to the resource-levelled schedule.

**Mitigation:** Ensure your `duration` and three-point estimates reflect
realistic resource availability, not theoretical parallel execution. If you have
a resource-levelled CPM baseline, use its task durations as your M values.

### P estimates must be genuinely pessimistic

A common mistake is setting P = M × 1.2 (20% contingency). PERT with σ = (P −
O) / 6 means a P that is only slightly above M produces a very narrow
distribution. The P estimate should represent a realistic bad scenario — a
dependency that slips, an approval that takes twice as long, a technical problem
that requires a rework cycle — not just a scheduling buffer.

A well-calibrated three-point estimate typically has P at 2–4× the O value,
not 1.2× M.

## OSS tier limits

| Limit | OSS default | Team tier |
|---|---|---|
| Max runs per request (`MC_SIMULATION_CAP`) | 1 000 | Unlimited |
| Max tasks per project (`MC_TASK_CAP`) | 500 | Unlimited |

Both settings can be changed in `settings/base.py` (or a local override). The
Team tier enterprise package sets both to `None` (unlimited) in its settings
include. Self-hosted OSS operators may set any integer or `None` in their local
settings — the cap is advisory, not license-enforced.

Exceeding either cap returns HTTP 402 with a structured error body:

```json
{
  "error": "simulation_cap_exceeded",
  "tier": "team",
  "message": "OSS tier supports up to 1000 simulations per run. Upgrade to Team tier for unlimited simulations."
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
counts the P95 value is noisy; run at Team tier for meaningful precision.

**Do not commit to P50.** A P50 date has a 50% probability of being missed by
definition. Committing to it is equivalent to flipping a coin on every project.

**Read the distribution, not just the percentiles.** The `distribution` field
contains every simulated finish date. A bimodal distribution — two clusters of
simulated dates — usually signals that one or two tasks have extreme P estimates
that dominate the tail. Investigate those tasks; they are your primary risk
drivers.
