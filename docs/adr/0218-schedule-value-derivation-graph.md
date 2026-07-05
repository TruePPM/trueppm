# ADR-0218: Server-side derivation graph for computed schedule values

## Status
Accepted

## Context

In the AI era the universal anxiety about any computed number is "can I trust
it?". An MCP/AI client (ADR-0186 read surface, ADR-0112 agent-as-actor) must be
able to ask not just *what* a computed early/late date, float, or Monte Carlo
percentile is, but **why** — which predecessor drove it, which constraint was
binding, how much came from lag versus a calendar snap, and which CPM pass
(forward/backward) set it. A citable, server-computed derivation is the antidote
to LLM hallucination and makes TruePPM the source of truth an agent defers to.

Today the CPM engine (`trueppm-scheduler`) computes `early_start`,
`early_finish`, `late_start`, `late_finish`, `total_float`, `free_float`, and
`is_critical` for every task, but the *reason* a value took its value — the
`argmax` of the early-start constraints in the forward pass, the `argmin` of the
late-finish constraints in the backward pass — is discarded the moment the value
is written. The only existing "why" surface is the Monte Carlo slice from #987
(`cpm_finish`, `delta_vs_cpm`, `confidence_curve`, and the ADR-0140 sensitivity
tornado), exposed on `GET /projects/<pk>/monte-carlo/latest/`. #1058 generalizes
that idea from the Monte Carlo forecast to the whole CPM engine.

**P3M layer**: Programs and Projects. This is single-project schedule *trust* —
a PM (Sarah) or an agent (Nadia's integration) explaining one project's own
dates. It is **not** cross-program narrative forensics or a portfolio
schedule-change narrative, which are Enterprise and stay there.

**Forces**
- Must be **computed server-side from the engine's own pass data**, never guessed
  and never recomputed in the browser (API-first, web-rule).
- Must **not fabricate** contributions: if a term (e.g. calendar lag) is not
  actually produced by the engine, compute it honestly or omit it (rule 120).
- Must not perturb the hot CPM passes — the Python and Rust/WASM engines are in a
  byte-for-byte conformance contract (ADR-0015), so adding "why" bookkeeping
  inside `_forward_pass`/`_backward_pass` would force a matching Rust change and a
  conformance re-baseline for a read-only feature that needs neither.
- Must be reachable by an MCP `mcp:read` token exactly as the Monte Carlo forecast
  is (ADR-0186 §E, `McpReadableViewMixin`).

## Decision

Add a **pure derivation module to the Apache-2.0 scheduler library** and surface
it through **one read-only API endpoint** mirrored to the read MCP surface.

### 1. Scheduler library — `packages/scheduler/src/trueppm_scheduler/derive.py`

A new pure function, exported from `__init__`:

```python
derive_value(project: Project, task_id: str, quantity: Quantity,
             result: ScheduleResult | None = None) -> Derivation
```

- `Quantity` is a `str`-enum: `early_start | early_finish | late_start |
  late_finish | total_float | free_float`.
- When `result` is omitted it calls `schedule(project)`; the API passes the
  freshly-computed `ScheduleResult` so the network is never scheduled twice.
- The function **recomputes only the target task's constraint list**, reusing the
  *same* helper formulas the passes use (`_next_working_day`,
  `_advance_calendar_days`, `_finish_from_start`, `_WorkingDayCounter`, the FS/SS/
  FF/SF branches). Because the predecessors'/successors' ES/EF/LS/LF are already
  final in `result`, deriving one task's one quantity is **O(degree(task))** — no
  whole-network re-pass. Mirroring the engine's own formulas is what makes the
  derivation faithful rather than a guess: the binding term the derivation reports
  is, by construction, the same `max()`/`min()` argument the engine took.

Return shape (`@dataclass`, each with `to_dict()` for JSON, matching the
library's existing `ScheduleResult.to_dict()` convention):

```
Derivation(
  task_id, quantity, value,                      # the computed value being explained
  pass_,                                          # "forward" | "backward" | "float"
  is_critical,
  binding: DerivationContribution,               # the single term that set the value
  contributions: list[DerivationContribution],   # every candidate constraint, binding flagged
)
DerivationContribution(
  kind,                 # "project_start" | "data_date" | "planned_start_snet"
                        #  | "predecessor_link" | "project_finish" | "successor_link"
                        #  | "early_start" | "late_start" | "successor_free_slack"
  source_task_id,       # the driving task for a link term; None for anchors
  dep_type,             # "FS" | "SS" | "FF" | "SF" for a link term; None otherwise
  lag_days,             # signed calendar-day lag on the link; 0 / None for anchors
  imposed_date,         # the date this term forced onto the target
  calendar_days_added,  # (snapped working day - raw offset).days — the calendar's
                        #  own contribution, computed, not guessed
  is_binding,
)
```

For `total_float` the binding terms are the task's own `early_start`/`late_start`
(with the working-day span between them as the value); for `free_float` the terms
are the per-successor slacks, binding = the tightest one — mirroring
`_compute_floats` exactly.

**Monte Carlo percentiles (P50/P80/P95) are handled at the API layer, not in
`derive.py`.** The "why" behind a percentile is already a first-class engine
output — `cpm_finish`, the signed `delta_vs_cpm`, and the ADR-0140 duration
sensitivity tornado (which tasks move the finish most). The derivation endpoint
*surfaces that existing data honestly* (§2) rather than inventing a second,
divergent computation of it. This is the "generalize #987" requirement met by
unifying the surface, not by recomputing the forecast.

### 2. API — `ScheduleDerivationView(McpReadableViewMixin, APIView)`

`GET /api/v1/projects/<pk>/schedule/derivation/?task_id=<id>&quantity=<quantity>`

- Permissions: `IsAuthenticated, IsProjectMember, IsProjectNotArchived` — the
  exact set on `MonteCarloLatestView` / `run_monte_carlo`. Any project role
  (Viewer+) may read a derivation; no attribution is exposed, so no Admin gate is
  needed.
- `McpReadableViewMixin` adds `ProjectApiTokenAuthentication` +
  `TokenReadOnlyMethods` + `TokenHasScope("mcp:read")` — a `tppm_` token with the
  read scope reaches it exactly as it reaches the Monte Carlo forecast.
- Builds the scheduler `Project` from the committed task set via the existing
  `build_sched_tasks()` + `build_sched_calendar()` converters (the single source
  of truth that keeps CPM/MC inputs from drifting), runs `schedule()`, then
  `derive_value()`.
- For a CPM `quantity`: returns the `Derivation.to_dict()` plus the task's value.
- For a Monte Carlo `quantity` (`p50|p80|p95`): reads the latest persisted
  `MonteCarloRun` (ADR-0175) and returns `{quantity, value, cpm_finish,
  delta_vs_cpm_days, drivers: sensitivity[]}` — the persisted engine output, with
  `404 {"detail": "No simulation result available."}` when no run exists (same
  contract as `MonteCarloLatestView`). No recompute, no fabrication.
- Error contract (documented for Nadia): `400` for a missing/unknown `quantity` or
  missing `task_id`; `404` for an unknown `task_id`, a project with no committed
  tasks, or (MC) no run; `404` (not `403`) for a non-member — the existing
  project-scope oracle via `get_object_or_404` + `check_object_permissions`.

### 3. MCP read tool — `packages/mcp/src/trueppm_mcp/tools.py`

Add `get_schedule_derivation(project_id, task_id, quantity)` following the
`get_monte_carlo_forecast` pattern: one authenticated GET to the endpoint above,
compacted via `_compact_mapping`, registered with `@server.tool()`. The docstring
carries the LLM-facing description ("the *why* behind a computed schedule value:
the driving predecessor, binding constraint, lag and calendar contributions, and
which pass set it").

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Pure `derive.py` recomputing the binding term locally (chosen)** | Engine passes untouched → no WASM conformance churn; faithful by construction (same formulas); O(degree); logic stays in the Apache-2.0 lib | A second code path mirrors the pass formulas — mitigated by unit tests asserting the derived binding equals the engine's value |
| B. Instrument `_forward_pass`/`_backward_pass` to record the argmax/argmin | Single source of the "why" | Forces a matching Rust/WASM change + conformance re-baseline; adds per-task bookkeeping cost to every schedule for a read-only feature; larger blast radius |
| C. Persist derivation on the `Task` model at CPM-run time | Cache-hit reads | New nullable JSON column + migration + broadcast wiring; stale the instant an input changes; derivation is cheap to compute on demand — persistence buys nothing |
| D. Compute it in the web client from the task list | No API work | Violates API-first / no-browser-recompute; unreachable by MCP/agents; would diverge from the engine |

## Consequences

- **Easier**: an agent (or the "Why this date?" web popover) can cite a
  server-computed, faithful reason for any CPM value; #987's Monte Carlo "why" and
  the new CPM "why" live behind one coherent surface.
- **Easier**: because the logic is in `trueppm-scheduler`, the pip package gains a
  reusable `derive_value()` for any downstream consumer.
- **Harder**: the derivation formulas in `derive.py` must stay in lockstep with any
  future change to the pass constraint logic. Guardrail: unit tests assert the
  derived `binding.imposed_date` equals the engine's computed value across FS/SS/
  FF/SF, lag, calendar-snap, SNET, and data-date fixtures — a divergence fails CI.
- **Risk (accepted)**: no `_provenance`/`stamp_answer` envelope is added. ADR-0112
  §2 describes such an envelope, but it is **not implemented at any read endpoint
  today** — `MonteCarloLatestView`, the precedent this feature mirrors, returns a
  plain computed dict. Introducing a bespoke envelope only here would diverge from
  the established MCP-readable pattern and is out of scope; the derivation payload
  *is itself* the provenance for its value. Adopting a uniform stamp across all
  MCP-readable computed endpoints is tracked separately (see Open question).
- **Boundary**: the endpoint is single-project and member-scoped; it exposes no
  cross-program data. Cross-program narrative forensics remains Enterprise.

## Open question (non-blocking)
A uniform `_provenance` envelope (ADR-0112 §2) across *all* MCP-readable computed
endpoints — Monte Carlo forecast, schedule derivation, KPI rollups — is a
cross-cutting change that should land once, consistently, not be introduced
piecemeal here. Deferred to a follow-up; this feature matches the current
(unstamped) precedent so it does not create a second inconsistency.

## Implementation Notes
- P3M layer: **Programs and Projects** (single-project schedule trust).
- Affected packages: **scheduler** (new `derive.py` + exports), **api** (view, URL,
  serializer, OpenAPI), **mcp** (read tool), **web** (optional "Why this date?"
  popover, deferred / follow-up), docs.
- Migration required: **no** — derivation is computed on demand from existing data;
  no model change.
- API changes: **yes** — one new read-only endpoint
  `GET /projects/<pk>/schedule/derivation/`.
- OSS or Enterprise: **OSS** (`trueppm-suite`). Verified boundary-clean
  (`grep -r trueppm_enterprise packages/` stays empty).

### Durable Execution
1. Broker-down behaviour: **N/A** — pure synchronous read endpoint; `derive_value`
   runs inline in the request cycle (like `run_monte_carlo`/`MonteCarloWhatIfView`),
   no async side effect, nothing to enqueue.
2. Drain task: **N/A** — no async work dispatched.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: reuses `scheduling/services.py::build_sched_tasks` /
   `build_sched_calendar` for the engine conversion; no new dispatch function.
5. API response on best-effort dispatch: **N/A** — synchronous `200` with the
   derivation body; `400`/`404` per the error contract above.
6. Outbox cleanup: **N/A** — nothing persisted.
7. Idempotency: naturally idempotent — a pure function of the project's current
   committed tasks; repeated GETs return identical results (CPM is deterministic).
8. Dead-letter / failure handling: **N/A** — a degenerate project raises the
   engine's documented `SchedulerError`/`InvalidScheduleInput`/`CyclicDependencyError`,
   caught and mapped to `400` with the engine's user-facing message (same handling
   as the Monte Carlo endpoint); nothing to retry or dead-letter.
