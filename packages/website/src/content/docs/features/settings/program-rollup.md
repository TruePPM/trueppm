---
title: Program rollup KPIs
description: Choose which project health signals roll up to the program overview, and how project health combines into the single program health dot.
documentedFor: "0.5"
---

A **program** groups several related projects under one PM. The **Program Settings → Rollup KPIs** page controls two things about how those projects' signals combine at the program boundary:

1. **Which KPIs appear** on the program overview — a per-KPI on/off list.
2. **How project health aggregates** into the single program health dot — one program-wide policy.

Open it at **Program → Settings → Rollup KPIs**. The design and rationale are recorded in [ADR-0169: Program rollup KPIs configuration](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0169-program-rollup-config.md).

This is intra-program only. A program rolls up its *own* projects; there is no cross-program aggregation — that would be portfolio scope, which is an Enterprise concern.

<!-- TODO(#722): screenshot — Program Settings → Rollup KPIs page showing the grouped KPI toggles and the health aggregation policy radio group. -->

## Permissions

| Action | Minimum role |
|--------|-------------|
| View the rollup config | Program Viewer |
| Change KPIs or the aggregation policy | Program Manager |

A program Viewer sees the page in read-only mode (a "Read-only" badge replaces the controls). Only a Program Manager or above can change the configuration.

## The KPIs

Ten KPIs can be enabled. The page groups them into three sections for scannability — the grouping is presentational only; the program stores a flat list of the enabled identifiers.

### Schedule

| KPI | Identifier | What it shows |
|-----|-----------|---------------|
| Schedule health | `schedule_health` | Each project's schedule performance band (the SPI proxy), combined by the aggregation policy. Not the program health band |
| Schedule variance (SV) | `schedule_variance` | Each project's mean lateness of completed baselined tasks, in days, combined by the aggregation policy (positive = late) |
| Baseline variance | `baseline_variance` | Each project's forecast finish minus its active-baseline finish, in days, combined by the aggregation policy (positive = later than the baseline) |
| Critical task count | `critical_tasks` | Incomplete tasks on the critical path, summed across the program's projects |
| Milestone health | `milestone_health` | Each project's milestone band (critical when an open milestone's forecast finish has passed, at risk when one is due within 7 days), combined by the aggregation policy |

### Risk

| KPI | Identifier | What it shows |
|-----|-----------|---------------|
| At-risk tasks | `at_risk_tasks` | Incomplete tasks with 5 or fewer working days of float, summed across the program's projects |
| Risk score | `risk_score` | Probability × impact of every open or mitigating risk, summed across the program's projects |
| P80 completion date | `p80_completion` | The latest P80 finish among the projects' own Monte Carlo forecasts |

The exact definition of each KPI, and what the API returns when one cannot be
computed, are on the [metric vocabulary](/features/metric-vocabulary/#program-rollup)
page. The rollup response carries the same sentences in its `definitions` map.

### Cost

| KPI | Identifier | What it shows |
|-----|-----------|---------------|
| Cost variance (CV) | `cost_variance` | Earned value minus actual cost, summed across the program's projects (negative = over budget) |
| Budget utilization | `budget_utilization` | Total actual cost ÷ total budget across the program's projects |

:::note[Ships in 0.5]
The two cost KPIs compute in 0.5, from the [cost model](/features/cost-model/). In the current release both are locked in the picker with the reason `no_cost_data` ("needs project cost data"), and **Budget-weighted** always falls back to the average.
:::

The cost KPIs carry a value only for someone who is **Program Manager** or Owner on the program **and** Project Manager or Owner on **every** project in it. A program role does not reach a project's budget. Everyone else, including a program Scheduler, Member or Viewer, sees them as **Restricted to managers of every project** (`cost_restricted`). They are unavailable, with a reason that names what is missing, when any project in the program has no budget (`no_budget`, with `projects_without_budget`), or when anyone who logged time on a project or is assigned to one of its tasks has no rate (`missing_rates`, with `missing_rate_count`). See [When a figure cannot be computed](/features/cost-model/#when-a-figure-cannot-be-computed).

Only enabled KPIs appear on the program overview and its rollup tiles. KPI toggles save **optimistically** — the switch flips immediately, and rapid changes are batched into a single save.

### KPIs that are not available yet

:::note[Ships in 0.5]
When 0.5 lands, every KPI will have a source and none will be locked. **P80
completion date** will compute from each project's latest Monte Carlo forecast:
the latest of those P80 dates, naming the project that sets it, dated by the
oldest forecast it read. Projects without a forecast will be left out and counted.
In the current release it is locked with the reason `no_montecarlo_store`
("needs stored Monte Carlo runs").
:::

A KPI with no backing data source is **shown but locked** in the picker. Its switch cannot be turned **on** — enabling one would save a KPI that could never render a value. Each row states why, and `GET /api/v1/programs/{id}/rollup-config/` returns the same set as `unavailable_kpis` (an identifier → reason-code map) so any API client can render the same explanation instead of hard-coding the list. The map is empty once every KPI has a source.

A KPI that is already enabled — because it was switched on earlier, or because the methodology defaults below seeded it — stays switchable **off** so you can clear it. Until you do, the overview shows a dash with the reason rather than a fabricated number: `GET /rollup/` returns `{"available": false, "reason": "..."}` for it.

An enabled KPI that has a source but no data yet (no baseline for the variances, no forecast for P80 completion) keeps its place in the response with a `null` value, or `unknown` for a band, and a `reason` saying what is missing.

The methodology defaults deliberately still seed these KPIs where they fit the methodology. That is forward-looking rather than an oversight: the intent ("this program should show cost variance") is recorded now, and the tile starts rendering on its own once the backing data lands — no settings change and no migration.

The KPI set is deliberately closed: the API rejects unknown identifiers rather than silently dropping them. Three KPIs that touched team-boundary or aggregation-correctness concerns (team velocity, scope-change count, resource utilization) were excluded during design review — see ADR-0169 for the reasoning.

## Methodology-aware defaults

A program does not start blank. When a program is created, its enabled-KPI list is seeded from the program's **methodology** (Waterfall, Agile, or Hybrid), so a new program is useful on day one without manual setup. Existing programs were seeded the same way when the feature shipped.

| Methodology | Default enabled KPIs | Default policy |
|-------------|----------------------|----------------|
| Waterfall | Schedule health, Baseline variance, Critical task count, Milestone health, Budget utilization, Cost variance | Worst-case |
| Agile | Milestone health, P80 completion date, At-risk tasks, Risk score | Worst-case |
| Hybrid | The union of the Waterfall and Agile sets (de-duplicated) | Worst-case |

Defaults are a starting point. Once seeded, the config is yours: changing the program's methodology later does **not** re-seed or overwrite your choices.

## Health aggregation policy

The aggregation policy decides how the individual project health signals combine into the **one** program health dot shown on the overview. That dot is the rollup of each project's schedule performance band, the same value as the Schedule health KPI; it is not a rollup of the project health chips. It is a single program-wide choice (a radio group), not a per-KPI setting. Because it changes what executives see at a glance, this control uses an **explicit Save** with an "Unsaved changes" prompt rather than saving on every click.

| Policy | Identifier | How project health combines |
|--------|-----------|------------------------------|
| Worst-case (recommended, default) | `worst` | Program health equals the worst health across all projects. One critical project makes the program critical. |
| Average | `average` | Numeric average of project health scores. Dilutes a single critical project. |
| Budget-weighted | `weighted_by_budget` | Each project is weighted by its budget. If any project has no budget, the rollup uses the average instead and reports `policy_available: false` with `policy_unavailable_reason: "no_budget"`. The weighting is applied only for someone who is Program Manager or above on the program and Project Manager or above on every project in it, because a weighted figure reveals how the budgets compare. Everyone else gets the average with `policy_unavailable_reason: "cost_restricted"`, whether or not any budget is set. |
| Task-weighted | `task_weighted` | Projects with more tasks carry proportionally more weight in the average. |

`worst` is the default and the recommended choice for most programs because it never lets a single critical project hide behind healthier ones. The weighted policies exist for client-facing rollups where a small fit-out should not drag down a large shell-and-core program. The chosen policy applies uniformly to every enabled KPI — there is no per-KPI policy override.

## FAQ

**Why are some KPI changes instant but the policy needs a Save button?**
KPI toggles are low-stakes display preferences, so they save optimistically. The aggregation policy changes the headline health signal executives read, so it uses an explicit Save to avoid silent flips.

**I enabled a KPI but no value shows on the overview.**
The settings page persists *which* KPIs are enabled for display. The rollup computation that produces the actual values is a separate part of the program overview; an enabled KPI with no underlying data (for example, no saved baseline for variance KPIs) will not render a value.

**Does changing the program methodology reset my KPIs?**
No. Methodology seeds the defaults only at creation. After that the config is user-owned and is never auto-recomputed.

**Can I roll up across multiple programs?**
No. Rollup is intra-program only. Cross-program and portfolio aggregation is an Enterprise capability outside the scope of this page.

**What is the API behind this page?**
`GET` and `PATCH` `/api/v1/programs/{program_id}/rollup-config/`, returning `enabled_kpis` (a list of identifiers) and `aggregation_policy`. Reads require program Viewer; writes require Program Manager or above. Every change is captured in the program's history for audit.
