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

## Amendment — #4778 (2026-11-07): My Work P80 and the sprint burn sources

Status: Accepted (2026-11-07, #4778). Implemented in the same change. It settles the
#4778 half of the Consequences bullet above that left "the My Work
`signals.forecast.p80_finish` and the sprint burn sources" for later; the #4779 half
(program rollup) is settled by the amendment that follows. The rows below extend the
§1 owner table. They sit here, not in it, so §1 stays as it was Accepted.

### Owners

| Metric | Owner | Field | as_of |
|---|---|---|---|
| Sprint burn series | `GET /sprints/{id}/burndown/` | `snapshots[].remaining_points` | `as_of` (new) |
| Sprint commitment | sprint burndown | `sprint.committed_points` (defined as `committed_points`) | `as_of` |
| Sprint burn pace | sprint burndown | `burn_status` + `burn_status_reason` (new) | `as_of` |
| Sprint trend | sprint burndown | `trend_points` | `as_of` |
| Sprint projected finish | sprint burndown | `projected_finish_date` | `as_of` |

No new owner is added for the My Work ship date. It is the §1 forecast owner,
`monte-carlo/latest/`, reduced across the reader's projects.

### Echoes

- **`/me/work` `signals.forecast`** echoes `monte-carlo/latest/`. It read only the
  persisted `MonteCarloRun`, the same disagreement #4760 fixed in status-summary:
  after a Member-triggered run (cache refreshed, no row, #1502) the card on the
  Contributor home showed a different P80 from the project's own forecast for up to
  a day. Each project's P80 is now read in the owner's order, cache entry first,
  then the newest persisted run, through
  `metric_provenance.latest_forecast_p80_by_project`. That is the batched form of
  `metric_provenance.latest_forecast_result`, which the owner itself
  (`MonteCarloLatestView`), status-summary's `monte_carlo_p80` and the overview's
  forecast fields now all call. Before this, each of the three held its own inline
  copy of the cache-then-newest-row read. The newest run is taken
  whatever its P80, as the owner does. The signal used to filter on `p80 IS NOT NULL`,
  which reported an older run's date when the newest had none. `as_of` is the
  driving project's `last_run_at`, the owner's as_of. The max across projects and
  the existing scoping (no drafts, the agent opt-out of ADR-0678) are unchanged.
  `definitions.p80_finish` states the reduction, since "the latest of several P80s"
  is not the single-project `p80` sentence.
- **`/me/work` `signals.sprint_burndown`** echoes the sprint burndown. It already
  read the same snapshots and called the same `compute_sprint_burn_status`. It now
  also carries `burn_status_reason`, `as_of` and `definitions`. Its series is named
  `series`, not `snapshots`, so its `definitions` are keyed `series` with the same
  sentence, the arrangement `task_slip_definitions` uses for task slip.
- **`/me/active-sprints/` `sprint.trend_pts`** held a second copy of the pace formula.
  Both callers now use `services.sprint_trend_points`. One difference is kept on
  purpose: with no snapshot yet the card reads the remaining points as the committed
  points ("nothing burned"), because `trend_pts` is the card list's sort key and is
  not nullable. The owner reports `no_data` with `burn_status_reason: no_snapshots`.
  Once a snapshot exists, the two agree. A test pins that.
- The sprint outcome's `velocity` block (`GET /sprints/{id}/outcome/`) already
  called `compute_sprint_burn_status`. It now also carries `burn_status_reason` and
  the owner's `definitions` for `burn_status`, `trend_points` and
  `projected_finish_date`, so a `no_data` there names its cause as the owner does.

### Sprint burn is not project burn

The issue's example, one sprint's slip reading 27 / 20 / 22 / 26 points, mixes two
metrics as well as two sources. `GET /projects/{id}/burn/` (owner in §1) counts every
task in the project, replayed from task history. The sprint burndown counts only the
sprint's committed tasks, from daily snapshots, and ignores pending mid-sprint
additions (ADR-0102 §2). They are both correct and they differ. Each now has its own
definition, and the published vocabulary states the difference. A surface that shows
a sprint figure reads the sprint burndown, never `/burn/`.

### Not-computable (rule 119)

`burn_status: no_data` conflated two causes. It now carries `burn_status_reason`:
`no_commitment` (no points committed at activation) or `no_snapshots`. The field is
null whenever a pace was computed.

The My Work `signals` block keeps ADR-0221's rule: a signal with no backing data is
omitted, not sent as null. It is a shipped contract that the web client keys on, and
the omission is the not-computable state for those cards. The vocabulary page says so.

### Surfaces left out on purpose

`GET /me/active-sprints/` carries neither `definitions` nor `as_of`, and the sprint
outcome `velocity` block carries `definitions` but no `as_of`. #4778 names the My Work
P80, the sprint burn signal and `/burndown/`, so these two are out of scope. Each
echoes the owner's formula (`trend_pts`, the burn reason) and is listed under Echoes in
the published vocabulary.

### Gates (inline)

- **enterprise-check:** OSS. The reader's own projects and their own soonest-ending
  sprint. Nothing is cross-program governance or portfolio.
- **ai-review:** passes. Each echoed figure now carries the owner's definition and an
  as_of an MCP client can cite. No agent write path changes.
- **threat-model:** n/a. No new trust boundary. The forecast echo reads the same
  membership-scoped project set as before. A cache entry for a project the reader is
  not a member of is never read, because the keys are built from that set.

### Implementation notes

- `metric_provenance.py`: the six new sentences, `SPRINT_BURNDOWN_DEFINED`,
  `MY_WORK_SPRINT_BURN_DEFINED`, `MY_WORK_FORECAST_DEFINED`, `definitions_by_field`,
  `definitions_field_by_field`, `BURN_STATUS_REASON_CHOICES`,
  `latest_forecast_result`, `latest_forecast_p80_by_project`.
- `services.py`: `compute_sprint_burn_status` (reason), `sprint_trend_points`,
  `_forecast_signal`, `_sprint_burndown_signal`, `_velocity_block`.
- `projects/views.py`: `SprintViewSet.burndown`, `MeActiveSprintsView`, the `/me/work`
  schema, and the forecast reads in `status_summary` and `ProjectOverviewView`.
  `scheduling/views.py`: `MonteCarloLatestView`.
- Tests: `packages/api/tests/apps/projects/test_metric_provenance.py`
  (`TestMyWorkForecastEchoesTheOwner`, `TestSprintBurnProvenance`).
- Cost: the forecast echo is one cache `get_many` plus at most one DISTINCT ON query
  and one project-name lookup, which is constant in the number of projects. The sprint
  figures add no query.

## Amendment — program rollup metrics (2026-11-07, #4779)

Supersedes, for the program rollup only, the Consequences line that left "the
program rollup's metrics (#4779)" without an owner. The Executive home renders
`ProgramOverviewPage`, which reads these figures from the rollup, so they need the
same three things every project figure has: an owner, a definition and an as_of.
One program at a time. Nothing here aggregates across programs, which stays
Enterprise (ADR-0070, ADR-0088).

### Owner table

| Metric | Owner | Field | as_of |
|---|---|---|---|
| Program health | `GET /programs/{id}/rollup/` | `program_health` (+ `program_health_reason`) | `as_of` |
| Schedule performance (program) | rollup | `kpis.schedule_health` | `as_of` |
| Milestone health | rollup | `kpis.milestone_health` | `as_of` |
| Critical / at-risk tasks (program) | rollup | `kpis.critical_tasks`, `kpis.at_risk_tasks` | `as_of` |
| Risk score | rollup | `kpis.risk_score` | `as_of` |
| Baseline / schedule variance | rollup | `kpis.baseline_variance`, `kpis.schedule_variance` | `as_of` |
| Cost variance / budget utilization | rollup | `kpis.cost_variance`, `kpis.budget_utilization` | `as_of` |
| P80 completion | rollup | `kpis.p80_completion` | `kpis.p80_completion.as_of` |

The payload carries `as_of` (when the server computed it) and a typed
`definitions` map: `program_health` always, plus one sentence per enabled KPI,
keyed by the KPI's name. The sentences live in `METRIC_DEFINITIONS` under
`program_health` and `rollup.<kpi>`. The prefix is there because `schedule_health`
is also a project figure with its own sentence. The metric-vocabulary page states
each sentence once, enforced by the existing sync test.

### Program health stays the SPI rollup

Decision (maintainer, 2026-11-07, on #4779): `program_health` is unchanged. It is
the SPI `schedule_health` bands rolled up under the aggregation policy, as
ADR-0088 defines it, and it is **not** a rollup of the project health band.

This amendment first proposed rolling up `compute_health_band`, so that a program
overview and the project rows beside it could not show two health vocabularies.
That was rejected on the data: the project band is critical whenever any
incomplete leaf task is on the critical path, and on real CPM output every project
with open work has a critical leaf (the longest path is never empty). Rolled up
under the default worst-case policy, nearly every program would read Critical, so
the figure would carry no information. The earlier example of a program "late on
SPI yet on track" cannot arise from CPM data for the same reason, and is not a
case this ADR relies on.

The disagreement risk is handled by naming instead. The definition of
`program_health` says it is the SPI rollup and "Not the project health band", the
way `schedule_health` says "Not the project health band" at project level, so a
client renders the sentence it is handed rather than its own.

- `Program.health` (the program manager's filed report) does not feed the payload,
  as before this amendment, so there is no `program_health_source`.
- `program_health_reason` is added (rule 119): `no_projects` for an empty program,
  `no_planned_work` when no contributing project has work planned by today, else
  null.
- `top_contributing_project` and the weekly program-health digest keep ranking and
  filtering on the same SPI bands the headline reads.

### P80 completion is computed

`p80_completion` was deferred (`no_montecarlo_store`, #753). The store it waited
for exists: the persisted `MonteCarloRun` (ADR-0175) plus the cache entry. The
figure is the latest P80 among the contributing projects. Each project's P80 is
the latest result `monte-carlo/latest/` serves: the cache entry first, then the
newest persisted run. That way it cannot disagree with the project forecast it
names.

- **Not a joint simulation.** The program finishes no earlier than its latest
  project, so a joint P80 would be this date or later. The definition says so.
- **Policy-independent**, like the counts. A mean of finish dates is not a
  completion date.
- **`as_of`** is the oldest `last_run_at` among the forecasts read, so the figure
  is dated by its oldest input.
- **Partial rollup.** Projects with no forecast (or none with a P80) are left
  out. `projects_without_forecast` counts them, so a client can say the figure
  excludes them. `driver_project_id` names the project whose P80 it is.
- `DEFERRED_KPI_REASONS` is now empty. The config endpoint still publishes it as
  `unavailable_kpis` for any future KPI without a source.

### Not computable (rule 119)

A configured KPI that cannot be computed keeps its `value` (`null`, or `unknown`
for a band) and gains a `reason`. `available` keeps its meaning ("this KPI can be
shown to this caller"), so the existing `available: false` reasons for cost are
unchanged. Reasons: `no_projects`, `no_planned_work` (schedule performance),
`no_milestones`, `no_baseline` (the variances), `no_completed_work` (schedule
variance with a baseline but nothing baselined done) and `no_forecast` (P80).

### Gates, inline

- **enterprise-check:** OSS. Every figure is computed over one program's own
  projects (`Project.program = this program`), and the program is the unit a
  single PM runs. No figure reads another program.
- **ai-review:** each figure an MCP client reads (`get_program_health` returns the
  payload as is) now has a definition and an as_of it can cite. P80 completion is
  explainable: it names its driver project, which the client can then explain with
  that project's own forecast. Read-only, so there are no agent writes. MCP's
  opted-out projects (ADR-0678) are excluded before any figure is computed, as
  before.
- **threat-model (STRIDE):** the read gate does not change. It is program
  membership (`IsProgramMember`, 404 for others). The one new exposure is
  information disclosure. A program member who is not a member of a project
  learns that project's P80 date when it is the program's latest, and its id as
  `driver_project_id`. This is the same class as the existing rollup KPIs (a
  one-project program's schedule band is that project's band) and the program's
  project roster, which program members already see. Accepted for the same reason
  ADR-0088 accepted the rollup. No forecast detail beyond the one date is exposed:
  no distribution, sensitivity or commitment. No write path, no broadcast.

### Cost

One extra grouped query for the project bands (`risk_counts_by_project`), which
replaces the SPI pass the headline band used to run unconditionally (that pass
now runs only when the `schedule_health` KPI is enabled). P80 completion costs one
`cache.get_many` and one `DISTINCT ON (project_id)` query. A not-computable
variance costs one `EXISTS` query, and only on that path. The query count does not
grow with the number of projects. A test pins this.

Implementation: `program_rollup.py` (`project_health_bands`,
`p80_completion_entry`, `_kpi_entries`), `ProgramRollupSerializer`, tests in
`tests/apps/projects/test_program_rollup_provenance.py`.
