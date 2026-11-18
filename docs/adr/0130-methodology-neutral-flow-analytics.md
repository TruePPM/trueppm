# ADR-0130: Methodology-Neutral Flow Analytics (Flow Metrics, Per-Column WIP Breach, Throughput Forecast)

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: flow-metrics)

> ADR-number note: `0129` is the highest committed number on main. `0130` is the next
> free slot. The ADR sequence has a documented collision history (nine reused numbers, per
> ADR-0126) and parallel branches are in flight — if another branch claims `0130` before this
> merges, renumber whichever lands second.

## Context

The 2026-06-10 product audit and a methodology-neutrality VoC panel (Agile Coach / Scrum
Master / PMO Director) found Kanban/continuous-flow coverage at ~55% vs Scrum's ~95%. Three
gaps, all for teams that run a board without timeboxing into sprints:

1. **#1072 — no flow metrics.** No cycle time, no lead time, no cumulative flow diagram (CFD),
   despite the data already existing: `Task.status` is tracked by `django-simple-history`
   (`HistoricalRecords`, status not excluded) and `Task.status_changed_at` records column entry.
   External consumers (and MCP clients, epic #986) cannot get cycle time without replaying
   history rows themselves.
2. **#1071 — no per-column WIP breach signal.** `BoardColumnConfig.columns` JSON already
   persists `wip_limit` per column (ADR-0039, already shipped; serializer already validates
   it), but the server never returns the **live per-column count + breach verdict** — so the
   breach state can only be computed client-side, violating API-first.
3. **#1161 — no forecast for sprintless teams.** Every delivery-forecast path is a hard
   dependency on closed-sprint rows. `velocity_summary()` filters
   `velocity_eligible_sprints()` (COMPLETED sprints) and `sprint_forecast` returns
   `status:"warming_up"` with `< 2` samples. A continuous-flow team that never closes a sprint
   gets `null`/`warming_up` forever, even though `Task.status` history + `actual_finish` record
   exactly the throughput needed for a count-based forecast.

**The forces:** This is the weakest leg of the 0.3 "Agile Team" story. It must lift Kanban
coverage **without forcing teams into sprints or Scrum vocabulary** (Morgan's "yet another
mandatory PM tool" objection). It must stay API-first (breach + forecast are server facts).
And — the central design tension surfaced by VoC — cycle time, throughput, and WIP are
**team-health signals**: if a project member who is also a PMO Director can read the raw
historical distributions, or a future cross-project rollup pulls them, they silently become a
surveillance metric (Morgan 🔴-if-ignored; Priya's pace-monitoring fear). They must be wired
to the existing ADR-0104 signal-privacy ladder with a named ceiling.

**P3M layer:** Programs and Projects + Operations — single-project/team delivery analytics.
This is the flow-team equivalent of the existing sprint-velocity forecast, which is OSS. No
cross-project or portfolio aggregation in this wave.

**VoC:** on-target cohort 7.0/10 (Alex 8 champion, Jordan 7, Morgan 7, Priya 6). Off-target
Janet/Marcus/David/Sarah scored 2–4 **by design** — they want portfolio rollup, which is
Enterprise and explicitly out of scope here.

## Decision

Ship three read-only, computed-on-read capabilities. **No new models, no migration.**

### D1 — Flow-metrics endpoint (#1072)

`GET /api/v1/projects/{pk}/flow-metrics/?window=<days>` (default 90 d, capped).

Computed from `Task.history` (the `HistoricalTask` model, queried the same way as
`burn_series()` / `sprint_daily_delta()` already do — `Task.history.model` with
`.values(...)`, diffing consecutive rows per task id):

- **Cycle time** per completed task = first transition **into** `IN_PROGRESS` →
  `COMPLETE` transition (fallback `actual_finish`). **Lead time** = earliest history row
  (board entry) → `COMPLETE`. Return P50/P80/P95 over the window (numpy percentiles).
- **CFD** = daily count of tasks in each canonical status across the window
  (`BACKLOG/NOT_STARTED/IN_PROGRESS/REVIEW/COMPLETE`; `ON_HOLD` folded into `BACKLOG` per
  ADR-0039), reconstructed from history rows.
- **Throughput** = tasks reaching `COMPLETE` per ISO week (the input series for D3).
- **`data_integrity`** advisory block: counts of bulk-moved / backdated / missing-transition
  tasks so consumers can caveat the numbers (Alex's "the CFD will lie if cards are
  bulk-moved" concern). Aggregate only — **never per-person** (Priya).

Bounded: one windowed `HistoricalTask` query ordered by `(id, history_date)`, percentiles in
Python. No per-task subqueries (perf-check gate).

### D2 — Per-column WIP breach verdict (#1071)

Persistence already exists (ADR-0039). Add the **server-computed breach verdict** to the
board-config read, so the breach is a server fact:

`GET /api/v1/projects/{pk}/board-config/` response gains, per column, a computed
(non-persisted, serializer-annotated) block:
```jsonc
{ "status": "IN_PROGRESS", "label": "...", "visible": true, "color": null,
  "wip_limit": 5,
  "current_count": 6,            // live count of non-deleted tasks in this status
  "breach": "over"               // "ok" | "at" | "over" | null (null = no limit set)
}
```
Breach is **passive** — visual-only on the board header (Priya/Morgan): no notification, no
standup ping, no escalation path, and (per ADR-0039) the API still does **not** reject
mutations that breach a limit. No new write path, no new broadcast.

### D3 — Throughput-based delivery forecast (#1161)

Generalize the existing probabilistic forecast (today `sprint_forecast`, the home of
`basis` + `status` + percentile dates) into a **unified delivery-forecast contract** with an
explicit input-basis discriminator:

```jsonc
{
  "basis": "velocity" | "throughput",        // which data drove the forecast
  "status": "ready" | "warming_up" | "insufficient_flow_history",
  "remaining_count": 42,                      // throughput path: remaining backlog item count
  "remaining_points": 88,                     // velocity path (unchanged)
  "sample_count": 11,                         // weeks of throughput (or sprints) sampled
  "p50_date": "2026-08-04", "p80_date": "2026-08-19", "p95_date": "2026-09-02",
  "velocity_suppressed": false                // ADR-0104 suppression flag (now general)
}
```

- For `delivery_mode=kanban` leaves (or any project with no `velocity_eligible_sprints()` but
  ≥ N weeks of throughput), forecast P50/P80/P95 completion via a **count-based Monte Carlo**:
  bootstrap-sample the weekly throughput series against the remaining backlog item count
  (`status=BACKLOG/NOT_STARTED/IN_PROGRESS/REVIEW`, excluding `COMPLETE`). No story points, no
  sprint cadence required.
- Replace the flow-team `warming_up`/`null` dead-end with either a real forecast or the new
  honest **`insufficient_flow_history`** status (mirrors the existing velocity warm-up honesty
  rule — no false precision). Threshold: `< MIN_THROUGHPUT_WEEKS` (propose 4) non-zero weeks.
- `basis` is surfaced so consumers/MCP never compare a throughput forecast to a velocity
  forecast unknowingly (Alex). Web renders a **range** (P50/P80/P95), never a single date.

**Sampler location:** the count-based bootstrap lives in the **API service layer**
(`apps/projects/services.py`), parallel to the existing `_sample_backlog_sprint_counts`. The
`packages/scheduler` engine stays Django-free and untouched this wave — the input is
`HistoricalTask`-derived (Django-only data), and a prior wave already established that inlining
the API-local sampler avoids the shared-worktree-venv gotcha. This is not a CPM/semantics
change, so **no wasm-scheduler conformance work is required.**

### D4 — Signal-privacy ceiling (the make-or-break decision)

Add **one new signal key** to `SIGNAL_DEFAULTS` (ADR-0104), pinning the new `flow_metrics`
audience the same way existing keys are pinned:

| Signal key | Default audience | Default ceiling | Governs |
|---|---|---|---|
| `flow_metrics` | `TEAM` | `TEAM` | cycle/lead distributions, CFD series, weekly throughput series |

Enforcement reuses the existing `can_read_signal(request, project_id, "flow_metrics")` gate and
a `suppress_flow_metrics()` helper modeled on `suppress_velocity_summary()`:

- **Historical performance analytics** (cycle/lead/CFD/throughput **series**) are gated under
  `flow_metrics`. Below-audience readers — e.g. a PM/PMO at the `TEAM_SM_PM` tier when audience
  is the `TEAM` default — get the payload with the distribution arrays emptied and
  `flow_metrics_suppressed: true`. Default keeps these team-and-coach only (Morgan/Priya).
- **Current board state** (D2 per-column counts + breach) stays visible to all project members
  — it is live operational state, not historical performance, and the board is already
  `IsProjectMember`-scoped.
- **Forecast dates** (D3 p50/p80/p95 + basis) follow the existing velocity precedent: schedule
  confidence **remains** visible (ADR-0104 keeps "milestone-health % and schedule confidence"),
  while the underlying throughput **series** is suppressed under `flow_metrics`. Mirror of how
  the velocity band stays but the per-sprint `sprints[]` series is stripped.
- A future cross-project rollup may read flow signals **only** via the existing
  `get_shared_team_signals()` extension point at the `PROGRAM_SHARED` ceiling — which a team
  must explicitly raise to. No back-door fan-out (closes Morgan's hard-NO).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **D3 in `packages/scheduler`** (extend `_sample_velocity_durations` with a count sampler) | Keeps all Monte Carlo in one place; reusable offline/WASM | Fights the shared-worktree-venv gotcha; scheduler would need Django-derived throughput passed in anyway; no CPM-semantics benefit; risks wasm conformance scope | 
| **D3 chosen: API service-layer sampler** | No venv friction; input is Django-only data; mirrors existing `_sample_backlog_sprint_counts`; no wasm parity work | Slight duplication of bootstrap logic across velocity/throughput paths |
| **New `forecast_basis` field** instead of repurposing `basis` | Zero risk to existing `basis:"monte_carlo"` consumers | Two near-identical fields; the issue explicitly asks for one clean `basis` discriminator |
| **Repurpose `basis` → `"velocity"\|"throughput"`** (chosen) | One stable contract, matches the issue; old value was a constant carrying no information | Contract change — must grep + repoint any web/MCP consumer of `basis === "monte_carlo"` at implementation time; note in changelog as a contract change (0.3 is alpha) |
| **Gate flow metrics behind a brand-new permission facet** | Maximal isolation | Reinvents ADR-0104; two consent models to reason about — exactly what ADR-0104 warned against ("one consent boundary, not two") |
| **No privacy gate (project-member read)** | Simplest | Triggers Morgan's hard-NO (surveillance by back door) and Priya's pace-monitoring fear — rejected |

## Consequences

**Easier:** flow teams get first-class cycle/lead/CFD/throughput + a real completion forecast;
the breach verdict and forecast become server facts an MCP client can read (#986). Kanban
coverage moves toward parity without any sprint mechanics or Scrum vocabulary.

**Harder:** cycle/lead-time computation correctness depends on `HistoricalTask` fidelity
(bulk-moves, backdating) — mitigated by the D1 `data_integrity` advisory and aggregate-only
framing. A second forecast basis means consumers must read `basis`.

**Risks:**
- *`basis` contract change* — grep web + `docs/api/` for `"monte_carlo"` consumers before
  repointing; if a real branch exists, fall back to the additive `forecast_basis` field.
- *`TaskStatusEnum` drf-spectacular collision* — `TaskStatus` is **not** in
  `ENUM_NAME_OVERRIDES`. Any new serializer field exposing `TaskStatus.choices` (CFD keys,
  breach payload) must either key by raw status strings (preferred — no enum emitted) or add a
  pinned `"TaskStatusEnum": "...projects.models.TaskStatus"` entry first, per
  the known enum-name-collision regression class.
- *ADR-number race* — see Status note; renumber if a parallel branch claims 0130.

## Implementation Notes
- **P3M layer:** Programs and Projects / Operations
- **Affected packages:** `api` (services + serializers + 1 new view + 2 augmented views +
  signal-privacy default), `web` (thin follow-up: flow charts + breach chip + forecast range,
  hosted in the #410 Kanban panel — **keep off the v2 shell files** a parallel agent owns)
- **Migration required:** **no** (projects head `0077`; `BoardColumnConfig.columns` already
  carries `wip_limit`; throughput is computed-on-read)
- **API changes:** yes — 1 new endpoint (`/flow-metrics/`), breach block on board-config read,
  unified `basis`/`status` on the delivery forecast. Sync `docs/api/openapi.json` (api-docs).
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). `grep -r trueppm_enterprise packages/`
  confirmed zero real imports — boundary clean. Cross-project rollup is the Enterprise seam via
  `get_shared_team_signals()`; not built here.

### Durable Execution
1. **Broker-down behaviour:** N/A — all three capabilities are pure read endpoints
   (computed-on-read). No async dispatch, no `.delay()`, no outbox row.
2. **Drain task:** N/A — no async work introduced.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** new pure-compute functions in `apps/projects/services.py`
   (`flow_metrics(project_id, window)`, `compute_wip_breach(board_config)`,
   `throughput_forecast(project_id)` + a `_sample_throughput_counts` bootstrap). No dispatch
   service involved.
5. **API response on best-effort dispatch:** N/A — synchronous reads return `200` with the
   computed payload (or the suppressed shape for below-audience readers).
6. **Outbox cleanup:** N/A — no outbox rows written.
7. **Idempotency:** N/A for writes (none). Reads are naturally idempotent and side-effect-free;
   the bootstrap uses a seeded `np.random.Generator` so a given history window yields a stable
   distribution within a request.
8. **Dead-letter / failure handling:** N/A — no tasks. A computation error surfaces as a normal
   `5xx`; an empty/insufficient history surfaces as `status:"insufficient_flow_history"` (D3) or
   empty series (D1), never an exception.
