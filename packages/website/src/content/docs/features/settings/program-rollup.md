---
title: Program rollup KPIs
description: Choose which project health signals roll up to the program overview, and how project health combines into the single program health dot.
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
| Change KPIs or the aggregation policy | Program Admin |

A program Viewer sees the page in read-only mode (a "Read-only" badge replaces the controls). Only a program Admin can change the configuration.

## The KPIs

Ten KPIs can be enabled. The page groups them into three sections for scannability — the grouping is presentational only; the program stores a flat list of the enabled identifiers.

### Schedule

| KPI | Identifier | What it shows |
|-----|-----------|---------------|
| Schedule health | `schedule_health` | Rollup of project health dots weighted by task count |
| Schedule variance (SV) | `schedule_variance` | Earned-value schedule variance vs. the saved baseline (negative = behind plan) |
| Baseline variance | `baseline_variance` | Aggregate schedule and cost variance vs. the most recent saved baseline |
| Critical task count | `critical_tasks` | Total tasks on the critical path across all projects in the program |
| Milestone health | `milestone_health` | Share of program milestones on track vs. slipped past their planned date |

### Risk

| KPI | Identifier | What it shows |
|-----|-----------|---------------|
| At-risk tasks | `at_risk_tasks` | Tasks flagged at-risk or already overdue |
| Risk score | `risk_score` | Weighted mean of open risk scores (probability × impact) across the risk register |
| P80 completion date | `p80_completion` | Monte Carlo P80 — the date by which 80% of simulated outcomes complete |

### Cost

| KPI | Identifier | What it shows |
|-----|-----------|---------------|
| Cost variance (CV) | `cost_variance` | Earned-value cost variance vs. the saved baseline (negative = over budget) |
| Budget utilization | `budget_utilization` | Approved budget consumed to date, aggregated across all projects |

Only enabled KPIs appear on the program overview and its rollup tiles. KPI toggles save **optimistically** — the switch flips immediately, and rapid changes are batched into a single save.

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

The aggregation policy decides how the individual project health signals combine into the **one** program health dot shown on the overview. It is a single program-wide choice (a radio group), not a per-KPI setting. Because it changes what executives see at a glance, this control uses an **explicit Save** with an "Unsaved changes" prompt rather than saving on every click.

| Policy | Identifier | How project health combines |
|--------|-----------|------------------------------|
| Worst-case (recommended, default) | `worst` | Program health equals the worst health across all projects. One critical project makes the program critical. |
| Average | `average` | Numeric average of project health scores. Dilutes a single critical project. |
| Budget-weighted | `weighted_by_budget` | Projects with larger approved budgets carry proportionally more weight in the average. |
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
`GET` and `PATCH` `/api/v1/programs/{program_id}/rollup-config/`, returning `enabled_kpis` (a list of identifiers) and `aggregation_policy`. Reads require program Viewer; writes require program Admin. Every change is captured in the program's history for audit.
