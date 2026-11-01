# ADR-1314: Metric provenance — one owning endpoint per metric, with a definition and an as_of

## Status
Accepted (2026-10-31, #4760). Implemented in the same change. Part of epic #1163;
a prerequisite for the shell v2 homes (#4755) and the S-curve and burn work (#4767).

## Context

The same project metric shows different values on different screens, and nothing
says what any of them means or when it was true. Measured on the marketing captures
for the Pass 1 redesign:

- one sprint's slip reads 27 / 20 / 22 / 26 points across four surfaces;
- one engineer's load reads 128/80, 24/80, 40% and "100% available";
- health reads Unknown / Unknown / At risk on a single page.

The cause is the same each time: a surface computes or labels its own number. The
health case is the clearest. `GET /projects/{id}/status-summary/` returns
`health_band` (the PM's manual report, else float and critical-path counts), and
`GET /projects/{id}/overview/` returns `schedule_health`, an SPI band that reads
`unknown` whenever nothing is planned yet. Both have been shown under the word
"Health".

Two smaller cases of the same thing were found during the audit for this ADR:

- `status-summary.monte_carlo_p80` read only the persisted `MonteCarloRun`, while
  `monte-carlo/latest/` serves the cache entry first. A Member-triggered run
  refreshes the cache and persists no row (#1502), so for up to a day the two
  endpoints returned different P80 dates for one project.
- `GET /projects/{id}/blocked/` returns `count`, which is the length of a list
  capped at `MAX_BLOCKED_ROLLUP_ROWS`. It is a row count, not the number of blocked
  tasks.

Shell v2's context header (ADR-1298) already shows health once and a P80 stamp.
Its tooltip carried a definition the web client wrote itself. The homes (#4755)
will put health, forecast and load on every landing page. Without one server fact
per metric they would repeat the disagreement under new chrome.

P3M layer: project and program (OSS). Nothing here is cross-program.

## Decision

### 1. One owner per metric

Each metric has exactly one owning endpoint, which computes it. Every other surface,
the web client, MCP and the homes, reads that value and only formats it.

| Metric | Owner | Field | as_of |
|---|---|---|---|
| Health band | `GET /projects/{id}/status-summary/` | `health_band` (+ `health_band_source`) | `as_of` |
| At-risk / critical counts | status-summary | `at_risk_count`, `critical_count` | `as_of` |
| Blocked count | status-summary | `blocked_count` (new) | `as_of` |
| P50 / P80 / P95 | `GET /projects/{id}/monte-carlo/latest/` (and the POST run) | `p50`, `p80`, `p95` | `last_run_at` |
| P80 vs commitment | monte-carlo/latest | `p80_delta_vs_commitment_days` (new) | `last_run_at` |
| Person load (per project) | `GET /projects/{id}/utilization/` | `resources[].days[].load_pct` | `as_of` |
| Team utilization | `GET /projects/{id}/overview/` | `team_utilization_pct` | `as_of` |
| Open risks | overview | `open_risk_count` | `as_of` |
| Schedule performance | overview | `schedule_health` | `as_of` |
| Burn series | `GET /projects/{id}/burn/` | `series` | `as_of` |
| S-curve (planned vs actual) | burn, `chart_type=burnup` | `series` + `baseline_series` | `as_of` |
| Task slip (one task) | `GET /projects/{id}/tasks/{task_id}/baseline/` | `finish_delta_days` | `as_of` |
| Task slip (rows) | task rows (`TaskSerializer`), the same computation | `baseline_finish_variance_days` | the comparison's `as_of`; on a list, `Project.recalculated_at` |

The issue asked for the burn endpoint to be consolidated, not duplicated. The
S-curve therefore gets no new endpoint. A burnup with the active-baseline overlay
is the cumulative planned-vs-actual curve already, and #4767 renders it from
`/burn/`.

`status-summary.monte_carlo_p80` stays as an echo of the forecast owner, for
compatibility. It now reads the same latest result (the cache entry, else the
persisted run), so it cannot disagree with the owner. Its schema text names the
owner.

The overview's forecast-derived fields (`risk_premium_*` and `forecast_staleness`)
are echoes of the same owner, and they read the same latest result in the same
order. They used to read only the persisted run, so after a Member-triggered run
the overview (and MCP `get_project`, which reads it) lagged `monte-carlo/latest/`
for up to a day.

The `count` on `/blocked/` stays the list's row count. The blocked metric is
`status-summary.blocked_count`, which uses the same rule (a non-empty
`blocked_reason` on a live row) without the cap. It is computed in the existing
aggregate, so the query count does not change.

Task slip is owned by the single-task baseline comparison. It carries `as_of` and
`definitions` on every branch, including `has_baseline: false`, which is the
not-computable case. Task rows carry the same computation under the name
`baseline_finish_variance_days`. A row in a paginated list has no response of its
own to carry an `as_of`, so the rows are an echo, and a test pins that the two agree.

### 2. Every owning payload carries `definitions` and an `as_of`

- **`definitions`**: an additive map with one sentence per figure on the payload,
  keyed by field name. The sentences live once, in
  `trueppm_api.apps.projects.metric_provenance.METRIC_DEFINITIONS`. Each endpoint's
  schema declares a typed `definitions` object, not a free-form one, so the e2e
  schema guard and generated clients know which keys to expect. The published
  `features/metric-vocabulary` page states the same sentences, and a pytest fails
  if any sentence is missing from that page or appears there more than once.
- **`as_of`**: the time the server computed the payload, on status-summary,
  overview, utilization and burn. These figures are read live, so a client that
  caches a payload shows its age from this field and not from its own fetch time.
  The forecast does not get a separate `as_of`. Its `last_run_at` already states
  when the simulation ran, and the ADR names that field as its `as_of`.

### 3. Commitment and the P80 delta (rule 119)

The commitment is the first of the following that applies:

1. the active baseline's finish: the latest `BaselineTask.finish` of the active
   baseline, counted only when the baseline has `has_cpm_dates=True`, for the
   reason `program_rollup` gives (#4242);
2. for a project in a program, `Program.target_date`;
3. none.

The forecast payload carries `commitment_date`, `commitment_source`
(`baseline` | `program_target` | `none`), `p80_delta_vs_commitment_days`, and
`p80_delta_vs_commitment_reason`. `definitions.commitment_date` is the sentence for
the rule that applied, which is how "the definition states which" is met. The delta
is measured in working time with `lazy_finish_shift_days`, the same reading rule as
every other finish comparison (#4197). A delta that cannot be computed is returned
as `null` with a reason, never omitted: `no_commitment` or `no_forecast`.

**Who sees the program's date.** Program membership is independent of project
membership (ADR-0070). Before this change `Program.target_date` reached only
program members, through the program serializer. When the program's date is the
commitment, the forecast now shows that date to every project member who can read
the forecast (Viewer and up). This is deliberate. That date is the commitment the
project is held to, and it is one date, not program detail. A fact that changed
with the reader's program role would also bring back the problem this ADR removes:
two people would see two different deltas for one project. Nothing else about the
program is exposed.

Pinned by tests: a project Viewer who is not a program member sees the
`program_target` commitment, and a soft-deleted program's date is ignored.

**Threat model of this boundary change (STRIDE, `threat-model` run inline).** The
asset is `Program.target_date`. The boundary is the project-membership read gate on
`monte-carlo/latest/` and the POST run (Boundary 1, authenticated API). The value
used to sit behind the program-membership gate.

- **Spoofing:** no new identity path. The read keeps the forecast's existing
  permissions: `IsAuthenticated`, `IsProjectMember` and `IsProjectNotArchived`.
- **Tampering:** read-only. The date is still written only through the program
  serializer, which requires Program Admin.
- **Repudiation:** no write and no new action, so there is nothing new to audit.
- **Information disclosure:** the one finding. A project member who is not a
  program member learns the program's target date. Accepted, for the reason
  above. Only the date is exposed: not the program's name, its id or its other
  projects. A soft-deleted program contributes nothing. MCP readers of the
  forecast see exactly what REST readers see. Nothing is broadcast over WebSocket
  (the forecast is not a broadcast payload).
- **Denial of service:** at most one extra indexed query per forecast read. The
  endpoint keeps its throttle scope.
- **Elevation of privilege:** none. Reading the date grants no program role and
  opens no program endpoint.

Outcome: 1 finding (information disclosure), accepted by the user and documented.
No other STRIDE category changes.

The commitment is derived on every response and is never stored with the run.
Activating a baseline or changing a program date moves the commitment without
moving the forecast.

### 4. The web reads one owner per metric and does not recompute

The per-metric read on the web is the existing hook for each owner:
`useShellStats` (status-summary), `useMonteCarloResult` (forecast),
`useResourceUtilization` (load) and the burn hooks. Surfaces may format a value.
They may not recompute it, and they may not write a definition of their own.
Rule 397 (the band word comes from `HEALTH_BAND_LABEL`) is the precedent.
`features/shell2/metricProvenance.conformance.test.ts` scans `features/shell2/`, and
a `features/home(s)/` directory once one exists, for the shapes recomputation
takes: a band derived from counts, hours divided by capacity, date subtraction,
percentile sampling, and a client-written definition. The P80 tooltip in
`ContextHeader2` now renders `definitions.p80` from the server.

## Alternatives Considered

- **A new `/projects/{id}/metrics/` endpoint returning every figure.** Rejected.
  It would be a second source for every figure, which is the class of problem this
  ADR exists to remove. It would also put the Monte Carlo read, the burn replay and
  the utilization engine, all with very different costs, behind one call and one
  throttle.
- **`definitions` as a free-form string map.** Rejected. The e2e schema guard does
  not check a free-form object, and a generated client could not tell which keys
  exist.
- **Keeping definitions in the web client.** Rejected. An MCP client could not
  explain a figure (the `ai-review` provenance check), and the tooltip text could
  drift from what the server computes.
- **An `as_of` on the forecast as well as `last_run_at`.** Rejected. It would be
  two names for one timestamp. The issue names `last_run_at` as the as_of.
- **Removing `status-summary.monte_carlo_p80` and `/blocked/`'s `count`.** Not
  done. Both are shipped contract. Making the first an exact echo and documenting
  the second as a row count removes the disagreement without a breaking change.

## Consequences

- Every figure in scope has one owner, a definition, and an as_of an MCP client can
  cite. The `ai-review` provenance check passes for them.
- `schedule_health` is defined as "Not the project health band". A v1 surface that
  labels it "Health" now visibly contradicts its own definition. Relabeling those
  surfaces is tracked in #4780.
- Person load is owned per project. A person's load across projects, which the
  Resource Manager home will need, has no owner yet. That home must extend the
  `utilization` engine named here rather than sum per-project loads in the client.
  The cross-project owner, and reconciling `/sprints/{id}/capacity/` and the
  `/me/work` `signals.utilization` figure with it, are tracked in #4777.
- Two further sources were deliberately left for later rather than owned here: the
  My Work `signals.forecast.p80_finish` and the sprint burn sources (#4778), and the
  program rollup's metrics (#4779). Until those land they are not owners in the
  sense of this ADR, and a home must not present them as the forecast or burn figure.
- Two small costs per forecast read: up to three indexed queries for the commitment
  (active baseline id, then max finish and the readings on that day), plus one
  query for the program when there is no baseline.
- One cache read per status-summary call (the P80 echo).

## Implementation Notes

- `packages/api/src/trueppm_api/apps/projects/metric_provenance.py`: the
  definitions, per-endpoint key lists, the typed schema helper, and
  `forecast_commitment_facts`.
- Owners touched: `ProjectViewSet.status_summary`, `ProjectViewSet.utilization`,
  `ProjectOverviewView`, `ProjectBurnView`, `run_monte_carlo`,
  `MonteCarloLatestView` (cache and persisted branches), `TaskBaselineDetailView`.
- Tests: `packages/api/tests/apps/projects/test_metric_provenance.py`.
- Docs: `packages/website/src/content/docs/features/metric-vocabulary.md`.
