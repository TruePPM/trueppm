# ADR-0140: Schedule "Forecast & sensitivity" — duration-sensitivity tornado

## Status
Proposed

## Context
The v2 Schedule redesign (epic #1163, Claude Design handoff `S.schedule`) docks a
collapsible **"Forecast & sensitivity"** insights bar at the bottom of the Schedule
view, with two columns:

1. **Finish-date forecast** — Monte Carlo histogram (P50–P80 band) + P50/P80/P95
   commit stats. The data already exists: the `monte-carlo/latest/` response carries
   `histogram_buckets`, `confidence_curve`, and `delta_vs_cpm` (ADR-0132), and the
   web already renders them in `MonteCarloRow` / `MonteCarloDetailPanel` /
   `MonteCarloHistogram`.
2. **"What's holding the date"** — a per-task **sensitivity ranking**: *the tasks
   that move the project finish most*, shown as labeled percent bars.

The sensitivity ranking does not exist. `trueppm_scheduler.MonteCarloResult` emits
only finish-date percentiles + the finish distribution. The web's current "top
drivers" list (in `MonteCarloDetailPanel`) is raw **PERT spread** — it ignores
network position, so a high-variance task that is never near the critical path ranks
misleadingly high. PERT spread answers "which task is most *uncertain*", not "which
task most *moves the finish*". Those are different questions; the panel needs the
second.

This is the core scheduling IP, so the metric and its output contract are recorded
here rather than decided ad hoc in the engine.

## Decision

### 1. Metric: duration-sensitivity via Spearman rank correlation
For each task, the **sensitivity index** is the absolute Spearman (rank) correlation
between that task's per-run sampled duration and the project's per-run completion
offset, across all Monte Carlo runs:

```
index(task) = | spearman( dur_matrix[:, task] , completion_offsets ) |   in [0, 1]
```

This is the @RISK / Crystal Ball "sensitivity tornado" — the de-facto standard for
"which input drives the output". Rationale for **rank** (Spearman) over Pearson: a
task's effect on the finish is monotonic but *nonlinear* (it only moves the finish
in the runs where its sampled duration is large enough to put it on the binding
path); rank correlation captures that where Pearson underweights it.

Computed inside the existing vectorised `monte_carlo()` numpy loop from data already
in hand (`dur_matrix`, `completion_offsets`) — no second simulation pass.

**Edge cases (all → the task is omitted, index 0):**
- **Zero-variance duration** — deterministic-duration tasks, completed tasks (pinned
  duration, ADR-0132), and milestones (zero duration) cannot move the finish. A cheap
  `ptp == 0` check skips them *before* the expensive rank sort.
- **Degenerate finish distribution** — a fully deterministic project has a constant
  completion offset (zero variance); every correlation is undefined → empty list.

### 2. Output contract
`MonteCarloResult` gains `sensitivity: list[TaskSensitivity]`, surfaced verbatim by
`to_dict()`:

```jsonc
"sensitivity": [
  { "task_id": "...uuid...", "index": 0.92 },   // sorted by index desc
  { "task_id": "...uuid...", "index": 0.78 },
  ...
]
```

- `index` in [0, 1]; the UI renders it as a percent bar.
- Sorted descending; **bounded to the top `MC_SENSITIVITY_CAP` (default 20)** entries
  so the payload and the bar list stay bounded regardless of task count.
- Task **name and critical-path color are NOT in the engine output** — they are
  derived client-side from the already-loaded task list (`task_id` join). The engine
  stays ID-based and name-agnostic, consistent with the rest of `MonteCarloResult`.

### 3. Persistence & API surface — parity with `histogram_buckets`
`sensitivity` is treated exactly like `histogram_buckets` and `confidence_curve`:
- It rides the `**mc_result.to_dict()` spread into the synchronous run response and
  the 24h `mc_latest:` Valkey cache — **no API view remapping**.
- It is **not** persisted to the `MonteCarloRun` history row, so the
  `monte-carlo/latest/` from-history fallback (cache-miss) returns an **empty**
  sensitivity list, the same graceful degradation `histogram_buckets`/
  `confidence_curve` already have. **No migration.**
- The endpoints' `@extend_schema` responses are `OpenApiTypes.OBJECT` (opaque); the
  prose descriptions are updated to mention `sensitivity`. No structural schema
  change, no new serializer.

### 4. Honesty (rule 166)
Both the velocity and throughput MC paths are real simulations, so percentile +
sensitivity vocabulary stays honest. Sensitivity is shown **only** when a real MC
result exists; with no run, the panel shows the existing "Run a simulation" empty
state — never a faked ranking.

## Consequences
- **Positive:** the panel answers the question a PM actually asks ("what do I protect
  to hold the date?") with a defensible, standard metric; zero new storage; the
  engine change is additive and auto-surfaces through the existing pipeline; available
  to MCP/AI clients as a first-class server fact (API-first).
- **Negative / bounded:** an O(n_tasks · runs log runs) rank pass is added to
  `monte_carlo()`. The zero-variance fast-path prunes completed/deterministic tasks,
  and `MC_TASK_CAP` (5 000) × `MC_SIMULATION_CAP` (1 000) bounds the worst case;
  `perf-check` validates it stays within the synchronous-request budget. If it ever
  regresses, the rank pass is independently cap-able via `MC_SENSITIVITY_CAP` on the
  *number of candidate columns* without touching the simulation itself.
- **WASM:** Monte Carlo is Python/numpy-only (the Rust/WASM engine is the deterministic
  CPM pass for offline recompute); sensitivity is an MC output, so there is **no WASM
  parity obligation** for this ADR. (The deterministic CPM contract is unchanged.)

## Alternatives considered
- **Criticality index** (fraction of runs where the task is on the binding path):
  also standard and more literally "on the critical path", but needs a per-run
  backward pass (late-finish/float) — more engine work and more perf risk for a
  marginally different ranking. Deferred; the tornado is the lower-risk, equally
  defensible choice (decision confirmed with the requester).
- **Reuse the existing PERT-spread "top drivers"**: rejected — it is not sensitivity
  (ignores network position) and is the very misrepresentation this ADR removes.
- **A new `monte-carlo/sensitivity/` endpoint**: rejected — sensitivity is a property
  of the same simulation; splitting it would force a second simulation or a second
  round-trip for one coherent result.
