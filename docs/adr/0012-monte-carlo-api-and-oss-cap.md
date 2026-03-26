# ADR-0012: Monte Carlo API endpoint and OSS tier simulation cap

## Status
Accepted

## Context

The `trueppm-scheduler` library has a fully implemented `monte_carlo()` function
(vectorised numpy, < 100 ms for 10 000 runs on a 200-task project) but it is not
wired into the API. The `recalculate_schedule` Celery task calls only `schedule()`
(CPM); Monte Carlo results are never persisted or returned to clients.

Issue #54 requires:
1. Wiring Monte Carlo into the API for the first time.
2. Enforcing an OSS tier cap (1 000 simulations / 500 tasks) that the enterprise
   package can lift by setting `MC_SIMULATION_CAP = None`.

**P3M layer:** Programs and Projects — single-project probabilistic schedule.
This is an OSS feature; the cap enforcement differentiates OSS from Team tier.

**VoC signal (avg 6/10):** The cap number is less important than the upgrade UX.
The 402 response must carry a human-readable `message` field; the UI must frame
the limit as a feature boundary, not an error.

## Decision

### 1. New exception in `trueppm-scheduler`

```python
# trueppm_scheduler/engine.py
class SimulationCapExceeded(ValueError):
    """Raised when n_simulations or task count exceeds the configured cap."""
    def __init__(self, message: str) -> None:
        super().__init__(message)
```

`monte_carlo()` gains two new optional keyword parameters:

```python
def monte_carlo(
    project: Project,
    runs: int = 1_000,
    seed: int | None = None,
    max_runs: int | None = 1_000,    # None = unlimited (Team tier)
    max_tasks: int | None = 500,     # None = unlimited
) -> MonteCarloResult:
```

The default for `runs` is changed from 10 000 to 1 000 to match the OSS default;
callers that want more pass a higher `runs` value (which the cap then validates).

Cap validation runs before any numpy allocation:
```python
if max_tasks is not None and len(project.tasks) > max_tasks:
    raise SimulationCapExceeded(
        f"This project has {len(project.tasks)} tasks. "
        f"OSS tier supports up to {max_tasks} tasks for Monte Carlo. "
        "Upgrade to Team tier for unlimited simulations."
    )
if max_runs is not None and runs > max_runs:
    raise SimulationCapExceeded(
        f"OSS tier supports up to {max_runs} simulations per run. "
        "Upgrade to Team tier for unlimited simulations."
    )
```

`SimulationCapExceeded` is exported from `trueppm_scheduler.__init__`.

### 2. New synchronous API endpoint

Monte Carlo is fast (< 100 ms) and returns no persistent state changes, so it
runs synchronously rather than via Celery. This avoids WebSocket round-trips for
a 402 case and keeps the error path simple.

```
POST /api/v1/projects/<pk>/monte-carlo/
```

Request body (optional):
```json
{ "n_simulations": 500 }
```
Defaults to `settings.MC_SIMULATION_CAP` if omitted.

Success response — 200:
```json
{
  "project_id": "...",
  "runs": 1000,
  "p50": "2025-11-14",
  "p80": "2025-12-02",
  "p95": "2026-01-08"
}
```

Cap exceeded — **402**:
```json
{
  "error": "simulation_cap_exceeded",
  "tier": "team",
  "message": "OSS tier supports up to 1000 simulations per run. Upgrade to Team tier for unlimited simulations."
}
```

Permission: `IsAuthenticated` + `IsProjectMember` (read access is sufficient;
no data is written).

### 3. New Django settings

```python
# settings/base.py
MC_SIMULATION_CAP: int | None = 1_000   # None = unlimited
MC_TASK_CAP: int | None = 500           # None = unlimited
```

The enterprise package overrides both to `None` in its settings include.
Self-hosted operators may set any integer or `None` in their local settings —
the cap is advisory, not license-enforced.

### 4. No persistence in this MR

Monte Carlo results are not stored. This keeps the schema stable and avoids
questions about result staleness. A follow-up issue can add
`Project.p50_finish / p80_finish / p95_finish` if caching becomes desirable.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: Synchronous endpoint (chosen)** | Simple, 402 is natural HTTP, no WS round-trip for error case | Blocks request thread for up to 100 ms |
| B: Extend Celery `recalculate_schedule` task | Keeps all schedule work async | 402 becomes a WS event, not HTTP — awkward for REST clients; harder to test |
| C: Cap enforced in API only, not scheduler | API is simpler | Scheduler can be called directly (CLI, notebooks) without cap — violates issue requirement |

Option A is chosen. The 100 ms synchronous ceiling is acceptable; Django's
default request timeout is 30 s. If larger projects cause regression, add
`@silk_profile` and revisit.

## Consequences

- **Easier:** Monte Carlo accessible via REST with a predictable 402 on cap breach.
  Enterprise settings override is a one-liner.
- **Harder:** The scheduler `runs` default changes from 10 000 to 1 000, which
  affects the performance test (`test_performance_10k_runs_200_tasks`) — that test
  must now pass `runs=10_000` explicitly.
- **Risk:** Changing the default `runs` is a breaking change for any direct caller
  of `monte_carlo()` who relied on the 10 000 default. Since the scheduler has no
  external callers yet (not released on PyPI), this is acceptable.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: `packages/scheduler`, `packages/api`
- Migration required: **no**
- API changes: new endpoint `POST /api/v1/projects/<pk>/monte-carlo/`
- OSS or Enterprise: OSS (`trueppm-suite`); enterprise overrides settings only
- Branch: `feat/monte-carlo-cap`
- Closes: #54
