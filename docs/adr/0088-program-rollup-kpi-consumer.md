# ADR-0088: Program Rollup-KPI Consumer

## Status
Accepted (decisions ratified by Kelly, 2026-05-25)

## Context
#527 (ADR-0079) shipped the **config** for program-overview KPI rollups — two
columns on `Program` (`rollup_enabled_kpis`, `rollup_aggregation_policy`) and the
`GET/PATCH /programs/{pk}/rollup-config/` endpoint — but **no consumer reads that
config**. The program overview shows no rolled-up values; the #527 acceptance
criterion "changes are reflected in the program overview KPI rollup" is unmet.
#713 builds the consumer.

**P3M layer:** Programs and Projects (OSS). One program aggregating *its own*
projects is the OSS adoption unit (ADR-0070). Cross-program/portfolio rollup
stays Enterprise — not in scope here.

Two forces collide:

1. **The KPI enum advertises more than the data model can compute.** The shipped
   `RollupKpi` enum has 10 values, but only 6 have a per-project source today:

   | KPI | Per-project source | Computable now? |
   |---|---|---|
   | `schedule_health` | SPI proxy (`ProjectOverviewView`) | ✅ |
   | `critical_tasks` | `Task.is_critical` (CPM) | ✅ |
   | `at_risk_tasks` | `Task.total_float ≤ 5` (CPM) | ✅ |
   | `baseline_variance` | `max(early_finish)` vs `max(BaselineTask.finish)` | ✅ (needs active baseline) |
   | `risk_score` | `Risk.probability × impact`, open risks | ✅ |
   | `milestone_health` | `Task.is_milestone` + `early_finish` vs today | ✅ |
   | `schedule_variance` | redefined schedule-only: `actual_finish − baseline_finish` of completed work (no cost) | ✅ (this ADR) |
   | `cost_variance` | — no cost fields anywhere | ❌ |
   | `budget_utilization` | — no budget field on Project | ❌ |
   | `p80_completion` | Monte Carlo, cache-only (`mc_latest:{pk}`), no DB store | ❌ |

   This is not hypothetical: the **methodology defaults seed non-computable KPIs**
   (`rollup_config_defaults`). A new WATERFALL program enables `budget_utilization`
   + `cost_variance`; a new AGILE program enables `p80_completion`. The "no data"
   path is the *default* experience, not an edge case.

2. **The 4 aggregation policies were designed for the health dot, not arbitrary
   KPIs.** ADR-0079's docstring: the policy describes "how project health combines
   into the program health dot." But the enabled KPIs are heterogeneous — ordinal
   health bands, additive counts, risk-exposure scores, signed day-variances, dates.
   "Average critical-task count per project" is not a number a PM asks for; "total
   critical tasks across the program" is. And `weighted_by_budget` has nothing to
   weight by (no budget field).

## Decision

**Scope (ratified): compute 7 KPIs now, define `schedule_variance` without cost,
split the two genuinely-blocked buildouts into their own issues.** #713 computes a
real rollup for **7 KPIs** under the **3 usable policies** (`worst`, `average`,
`task_weighted`):

- The 6 already-sourced KPIs, **plus `schedule_variance`** computed as a
  *schedule-only* metric (no cost): the lateness of completed work against its
  baseline finish, reusing the existing per-task definition
  `actual_finish − baseline_finish` (serializers.py `get_schedule_variance_days`).
  This is distinct from `baseline_variance` (projected **end-date** drift) — SV
  measures *how late finished work landed*, baseline_variance measures *where the
  project end is heading*. Null when no active baseline / no completed tasks.

The remaining **3 KPIs return a typed *unavailable* marker** with a machine- and
human-readable `reason` — never a fabricated zero — until their dedicated issue
lands:

- `p80_completion` → blocked on a **persistent Monte Carlo result store** (today P80
  is a 24h cache entry only; `status_summary` already returns `monte_carlo_p80:
  None`). New issue filed.
- `cost_variance`, `budget_utilization` → blocked on a **cost/EVM data model**.
  Decision: *actual cost = time entries × labor rates* (requires a rate model).
  Also unblocks the `weighted_by_budget` policy. New issue filed.

**Endpoint.** New read action on the existing `ProgramViewSet`:
`GET /api/v1/programs/{pk}/rollup/` → permission `IsProgramMember` (Viewer+).
Mirrors the sibling `rollup_config` action; keeps program logic in
`program_views.py`. Pure read, computed on demand.

**Response shape:**
```jsonc
{
  "aggregation_policy": "worst",
  "policy_available": true,          // false when policy=weighted_by_budget (no budget)
  "project_count": 4,                // non-deleted member projects
  "program_health": "at_risk",       // the dot: schedule_health reduced by policy
  "kpis": {
    "schedule_health":   { "available": true,  "value": "at_risk" },
    "critical_tasks":    { "available": true,  "value": 12 },
    "at_risk_tasks":     { "available": true,  "value": 7 },
    "baseline_variance": { "available": true,  "value": 9, "unit": "calendar_days" },
    "schedule_variance": { "available": true,  "value": 4, "unit": "calendar_days" },
    "risk_score":        { "available": true,  "value": 84 },
    "milestone_health":  { "available": true,  "value": "on_track" },
    "budget_utilization":{ "available": false, "reason": "no_cost_data" },
    "cost_variance":     { "available": false, "reason": "no_cost_data" },
    "p80_completion":    { "available": false, "reason": "no_montecarlo_store" }
  }
}
```
Only `enabled_kpis` appear in `kpis`. A disabled KPI is simply absent.

**Per-KPI reducer — the policy applies where it is meaningful, natural reducers
elsewhere.** Each KPI has a *value type* that fixes how it rolls up:

| Value type | KPIs | `worst` | `average` | `task_weighted` |
|---|---|---|---|---|
| **Health** (ordinal: critical<at_risk<on_track; `unknown` excluded from the reduce) | `schedule_health`, `milestone_health` | worst band present | mean ordinal → nearest band | task-count-weighted mean ordinal → band |
| **Variance** (signed calendar-days slip; higher = worse) | `baseline_variance`, `schedule_variance` | max slip | mean slip | task-weighted mean slip |
| **Count** (additive) | `critical_tasks`, `at_risk_tasks` | **program total (sum)** | program total (sum) | program total (sum) |
| **Score** (additive risk exposure) | `risk_score` | **program total (sum)** | program total (sum) | program total (sum) |

Rationale for Count/Score being policy-independent: a count or total risk-exposure
*is* a program-level fact — the sum is the only PM-useful number. "Worst-casing" or
"averaging" a count produces a figure no one acts on. The policy governs the
**health bands and the variance** (the genuinely combinable signals) and the
headline **program health dot**, which is exactly what ADR-0079 designed it for.

**`weighted_by_budget` fallback.** When the program's policy is `weighted_by_budget`
(no budget field exists), Health/Variance reduce by `average` and the response sets
`policy_available: false` so the UI can show "budget weighting unavailable —
showing average." The rollup is never blanked just because the chosen policy can't
be honored.

**Program health dot drives `Program.health` when AUTO.** `Program.health` defaults
to `AUTO` precisely so the rollup can supply it. The endpoint's `program_health` is
the computed dot; the manual `Program.health` override (when not AUTO) wins for
display. (Persisting the dot is out of scope — computed on read.)

**Follow-ups filed by this work:**
- **#754** — *Cost/EVM data model (actual cost = time entries × labor rates)* →
  unblocks `cost_variance`, `budget_utilization`, and the `weighted_by_budget` policy.
- **#753** — *Persistent Monte Carlo result store* → unblocks `p80_completion`
  (today it is a 24h cache entry; `status_summary` already returns
  `monte_carlo_p80: None`).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. Aggregate the available subset; mark the rest unavailable** (chosen) | Ships real value now; honest about gaps; bounded scope; matches existing `monte_carlo_p80: None` precedent | Default configs show "unavailable" cards until follow-ups land |
| B. Build the missing per-project computations in #713 | Every enabled KPI resolves | Scope blow-up: adds budget/cost EVM data model + MC result store + SV definition — several ADRs and migrations. Not one issue. |
| C. Apply the policy uniformly to **all** KPIs (literal reading of the issue) | One rule, no per-type table | "Average 3.5 critical tasks/project" and "worst-case count" are not PM-useful; over-fits the policy to metrics it was not designed for |
| D. Hide unavailable KPIs entirely (omit from response) | Cleaner-looking overview | Silently drops KPIs the PM explicitly enabled; the preview panel (#673) can't explain *why* a toggled KPI shows nothing |

## Consequences
- **Easier:** the program overview finally renders rolled-up values; #673's preview
  panel has a concrete computed payload to preview against; the program health dot
  has a real source for `AUTO`.
- **Harder:** the `available/reason` envelope must be threaded through the web layer
  and #673; consumers must handle per-KPI availability, not assume a flat value.
- **Risks:** (1) per-project `schedule_health` is baseline-sensitive — projects with
  no active baseline contribute `unknown` and are excluded from the health reduce,
  which can make a program look healthier than it is; documented, and `project_count`
  vs contributing-count lets the UI disclose it. (2) N+1 across a program's projects
  if implemented naively — see Implementation Notes.

## Implementation Notes
- **P3M layer:** Programs and Projects (OSS).
- **Affected packages:** api (new `ProgramViewSet.rollup` action + a
  `program_rollup.py` service for the reduce logic; serializer for the response),
  web (program-overview KPI strip honoring `available`).
- **Migration required:** **no.** Reads existing columns; no schema change. (Keeps
  #713 off the `migration-check` path entirely.)
- **API changes:** yes — one new read endpoint `GET /programs/{pk}/rollup/`. OpenAPI
  schema regenerates.
- **OSS or Enterprise:** OSS. Intra-program only; no `trueppm_enterprise` import.
- **Performance:** do **not** call `ProjectOverviewView` per project. Compute with a
  small fixed number of `values("project").annotate(...)` grouped queries across
  `program.projects.filter(is_deleted=False)` (task counts, critical/at-risk, SPI
  inputs, baseline finish, open-risk severity), then reduce in Python. Target ≤200 ms
  p95 at program scale, matching ADR-0030's project-overview budget. `perf-check`
  before MR.

### Durable Execution
1. Broker-down behaviour: **N/A** — pure read endpoint, computed on demand, zero
   async side effects and no DB writes. Nothing to dispatch.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: new **`program_rollup.py::compute_program_rollup(program)`** pure
   function (no I/O beyond the read queries); called by the view. Kept out of the
   view so #673's preview action can reuse the identical reduce.
5. API response on best-effort dispatch: **N/A** — synchronous `200` with the rollup.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A for writes**; the computation is deterministic for a given DB
   state (pure function of the projects' current rows), so repeated GETs are
   referentially consistent.
8. Dead-letter / failure handling: **N/A** — no task. A project contributing no data
   (e.g. no baseline for `baseline_variance`) is excluded from that KPI's reduce, not
   an error.
