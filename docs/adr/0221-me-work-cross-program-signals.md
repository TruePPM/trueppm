# ADR-0221: Cross-program signals on /me/work/ for the My Work focus cards

## Status
Accepted

## Context
The My Work v2 home (#1228) leads with risk-ranked focus cards, but those cards
currently render only what `/me/work/` returns — task counts and minimal active
sprint cards. The v2 spec's richer signals (schedule health / SPI, a Monte-Carlo
P80 ship-date forecast, utilization, a real sprint burndown) are project-level
computations that the contributor surface has not had access to, so the cards
*honestly omit* them (rule 120 — never fabricate a number). #1236 asks to add
per-user **cross-program aggregates** to `/me/work/` so each card can show a real
signal instead of a placeholder.

The governing constraint is rule 120: **surface a signal only where a real
server-side computation already exists to back it; honestly omit the rest.** A
partial-but-honest delivery is the correct outcome. Faking is worse than omitting.

**P3M layer: Programs and Projects / Operations (OSS).** This is a *within-user*
aggregate strictly scoped to the requesting user's own member projects — the same
scope as the existing `/me/work/` task queryset. It is **not** cross-program
portfolio governance (which would aggregate across other people's work and belongs
to Enterprise). A contributor rolling up signals over *their own* assigned work
across the programs they are a member of is the OSS "run my own work" case.

### Which of the four requested signals are backable
An audit of the scheduler / EVM / Monte-Carlo / sprint / resource-allocation code:

1. **Schedule health / SPI — BACKABLE.** `program_rollup._schedule_health_by_project(
   project_ids, today)` computes an SPI-proxy band per project
   (`on_track|at_risk|critical|unknown`: completed-by-today ÷ planned-by-today, via
   the active baseline's snapshot finishes, falling back to CPM `early_finish`) in a
   fixed, small number of grouped queries — no per-project loop. `_reduce_health()`
   reduces bands worst-first. Both are reusable directly over the user's member set.

2. **Monte-Carlo P80 / ship-date forecast — BACKABLE.** `scheduling.models.MonteCarloRun`
   persists the latest per-project forecast (`p50/p80/p95/cpm_finish/taken_at`). It is
   present only for projects where a forecast has actually been run — so it is
   naturally honest: a project with no run contributes nothing. The latest run per
   project is one `DISTINCT ON (project_id)` query.

3. **Utilization / capacity % — NOT BACKABLE cross-program per user → OMIT.** The only
   per-resource capacity computation (`capacity_summary` / `_capacity_summary_from_rows`)
   is (a) sprint-scoped, (b) driven by `TaskResource` allocations (units) — a *different*
   assignment axis than `Task.assignee`, which `/me/work` uses — and (c) requires the
   user to have a linked `Resource` (a nullable FK, frequently unset for contributors).
   There is no cross-program per-user "load vs target" rollup keyed off the user's
   assigned work; the program rollup itself defers `budget_utilization`
   (`"no_cost_data"`), and #1236 flags utilization as needing #489/#747. Presenting a
   utilization % here would be fabrication-adjacent. **Card 3 stays the honest
   open-task count it is today.**

4. **Sprint burndown series — BACKABLE.** `SprintBurnSnapshot` is a real persisted
   daily series (`remaining_points`, `remaining_task_count`, `completed_points`,
   `snapshot_date`) written on task-status changes; `compute_sprint_burn_status()`
   yields `{burn_status, trend_points, projected_finish_date}`. We surface the real
   series for the user's *soonest-ending* active sprint (the clock that matters most),
   replacing the fabricated direction-only ramp the spark uses today.

## Decision
Add one additive top-level key, `signals`, to the `/me/work/` response, computed by a
new pure service function `me_work_signals(user, active_sprints, today)` in
`projects/services.py`. Each of the three backable signals is a sub-key that is
**present only when it has real data**; an absent sub-key means "no real source →
render the card as-is" (the honest-omission contract). Utilization is never emitted.

`signals` is computed **only on the first page** of the paginated response
(`offset == 0`). The web `useMyWork` infinite query reads aggregates from `pages[0]`;
gating avoids re-running ~7 grouped queries on every scroll page. When the key is
absent (subsequent pages), the web falls back to its current honest behavior.

### Response shape
```jsonc
"signals": {
  // Present only if ≥1 member project has a non-"unknown" band.
  "schedule_health": {
    "band": "at_risk",          // worst-first reduce (on_track|at_risk|critical)
    "project_count": 3          // projects contributing a real band
  },
  // Present only if ≥1 member project has a MonteCarloRun.
  "forecast": {
    "p80_finish": "2026-08-14", // latest (max) P80 finish across those projects
    "project_id": "…",
    "project_name": "Apollo Platform",
    "as_of": "2026-07-01T09:12:00Z" // taken_at of the driving run (freshness)
  },
  // Present only if the user has an active sprint with ≥1 burn snapshot.
  "sprint_burndown": {
    "sprint_id": "…",
    "sprint_name": "Sprint 12",
    "committed_points": 40,
    "series": [                  // real SprintBurnSnapshot rows, ascending by date
      { "date": "2026-05-20", "remaining_points": 40 },
      { "date": "2026-05-21", "remaining_points": 36 }
    ],
    "burn_status": "behind",     // ahead|on_track|behind|no_data
    "trend_points": -5,          // signed; positive = ahead of ideal
    "projected_finish_date": "2026-06-03"
  }
  // NO "utilization" key — intentionally omitted (no real cross-program per-user source).
}
```

### Query plan (bounded — no per-project / per-sprint loop)
Over `member_project_ids` (resolved once):
- 1 query: member project ids (reuses `ProjectMembership` scope).
- schedule_health: `_schedule_health_by_project` — its existing ~3–4 grouped queries.
- forecast: 1 `MonteCarloRun.objects.filter(project_id__in=…).order_by("project_id",
  "-taken_at").distinct("project_id")` (Postgres `DISTINCT ON`), then max P80 in Python.
- sprint_burndown: the lead sprint is picked from the `active_sprints` queryset already
  materialized by `list()` (passed in, not re-queried); 1 query for that one sprint's
  burn snapshots.

≈7–8 extra grouped queries, first page only. All scoped to the user's member projects.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Inline the aggregate in `MeWorkView.list()` | No new symbol | Not unit-testable in isolation; bloats an already-long view |
| **Pure service `me_work_signals(...)` (chosen)** | Testable, reuses existing rollup helpers, honest-omission is a single contract point | One new function |
| Fabricate utilization from open-task count as a "%" | Fills the card | Rule 120 violation — a count is not a capacity ratio; misleads |
| Compute signals on every page | Symmetric with active_sprints | ~7 grouped queries × every scroll page for data the web reads only from page 1 |
| New dedicated `/me/signals/` endpoint | Clean separation | Extra round trip on mount; the cards want it inline with the task list |

## Consequences
- **Easier:** the focus cards show three real, server-computed signals; the spark
  becomes a real burndown; a P80 ship-date and a schedule-health band are first-class
  facts (API-first / MCP-reachable), not client guesses.
- **Harder:** `/me/work/` first-page latency grows by a bounded set of grouped queries;
  the perf gate must confirm no per-project loop crept in.
- **Risks:** none to correctness — every emitted number traces to an existing
  computation. The main risk is *scope creep* into utilization; the ADR explicitly
  fences that off. Privacy: all sources are within the user's member projects (the
  user is at minimum a Member of any project they are assigned to), so no ADR-0104
  velocity/points side-channel is opened that the user could not already see on those
  projects' own surfaces.

## Implementation Notes
- P3M layer: Programs and Projects / Operations (within-user rollup).
- Affected packages: api (view + service + serializer field), web (hook types + focus
  card / side column components), docs (api reference + openapi).
- Migration required: **no** — read-only aggregate over existing models.
- API changes: **yes** — additive `signals` object on the `GET /me/work/` first page.
- OSS or Enterprise: **OSS** (`trueppm-suite`). Within-user, within-member-projects;
  not cross-program portfolio governance.

### Durable Execution
1. Broker-down behaviour: **N/A** — pure read endpoint, zero async side effects.
2. Drain task: **N/A** — no async work dispatched.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: new pure read function `projects/services.py::me_work_signals()`.
5. API response on best-effort dispatch: **N/A** — synchronous read, `signals` inlined
   in the 200 response.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A for writes**; the read is deterministic for a given DB state and
   safe to call on every GET.
8. Dead-letter / failure handling: **N/A** — no task. A source with no data yields an
   absent sub-key (honest omission), never an error.
