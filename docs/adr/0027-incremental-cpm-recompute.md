# ADR-0027: Incremental CPM recompute

## Status
Proposed

## Context

Issue #8 ships auto-scheduling via `recalculate_schedule`, but the Celery task
always performs a **full** CPM recompute regardless of how small the change was.
For a 2,400-task project with a 5-task edit, the server re-scans the entire graph,
re-runs forward and backward passes on every task, and writes every `early_start`,
`early_finish`, `late_start`, `late_finish`, `total_float`, `free_float`, and
`is_critical` field.

**P3M layer**: Programs and Projects (single-project CPM). **OSS.**

**VoC** (avg 5.4/10, Marcus 9/10):

> "My largest project is 2,400 tasks. A 5-task change triggering a full recompute
> that takes 15 seconds means my PMs stop running the recalc, which means my
> portfolio data goes stale, which means my whole business case for the tool
> collapses."

This is a **scale-the-sale blocker**, not a perf nice-to-have. Full recompute is
correct but slow; incremental is fast but must prove correctness. The gate is not
"is incremental fast enough?" — it is "does incremental produce bit-exact results
vs full?"

### Non-goals

- Not redesigning the CPM algorithm — only the scope of its input.
- Not changing the Rust WASM scheduler — that engine already has
  `incremental_update` per ADR-0015; this ADR is for the authoritative Python engine.
- Not replacing the full-recompute path — full stays as the default and the
  fallback.

## Decision

### Scheduler engine — new parameter

```python
# packages/scheduler/src/trueppm_scheduler/engine.py
def schedule(
    project: Project,
    *,
    changed_task_ids: set[str] | None = None,
) -> ScheduleResult:
    """CPM recompute.

    When changed_task_ids is provided and small, recompute only the affected
    subgraph (ancestors + descendants of the changed set, transitively).
    Otherwise, or when the set exceeds 25% of tasks, full recompute.
    """
```

Decision to go incremental vs full is made **inside the scheduler engine**, not
the API. The API supplies `changed_task_ids` when it knows them; the engine
decides whether the set is worth incrementalizing.

### Heuristic — fallback threshold

Fall back to full recompute when:

- `changed_task_ids is None`, OR
- `len(changed_task_ids) / len(project.tasks) > 0.25`, OR
- The subgraph closure (ancestors + descendants) covers more than 50% of tasks
  (computed after ancestry expansion).

These thresholds are empirical and tunable via a settings constant
(`SCHEDULER_INCREMENTAL_CHANGE_RATIO` = 0.25, `SCHEDULER_INCREMENTAL_CLOSURE_RATIO`
= 0.50). When either threshold is exceeded the engine logs the reason and proceeds
with full recompute — the caller doesn't need to know.

### Subgraph extraction

Given a set of changed task IDs:

1. Compute **descendants closure** — all tasks reachable via forward dependencies.
   Their ES/EF/LS/LF may change.
2. Compute **ancestors closure** — all tasks reachable via reverse dependencies.
   Their LS/LF may change (the backward pass propagates backward).
3. Union = incremental set. Run forward pass on descendants-ordered, backward pass
   on ancestors-reverse-ordered, float recompute on union.
4. Critical-path flag recomputed on union; tasks outside union retain prior
   `is_critical` value.

Subgraph extraction uses `networkx.ancestors` and `networkx.descendants` — O(V+E)
per call, cheap vs the CPM cost.

### Service layer — explicit caller-supplied changes

```python
# packages/api/src/trueppm_api/apps/scheduling/services.py
def enqueue_recalculate(
    project_id: UUID,
    *,
    changed_task_ids: Sequence[UUID] | None = None,
) -> None:
    """Enqueue CPM recompute via the transactional outbox."""
```

**Callers supply `changed_task_ids` explicitly.** Signal-driven accumulation was
rejected: signals create hidden coupling, and a missed signal silently degrades
every downstream user's data. Marcus's "wrong data is worse than slow data"
is the explicit design principle here.

When a caller doesn't know (e.g. bulk import, MS Project import, dependency
restructure touching many tasks), it passes `None` and gets full recompute — a
correct and sufficient default.

#### Callers and what they pass

| Caller | `changed_task_ids` |
|---|---|
| `TaskViewSet.perform_update` | `{self.instance.id}` (single-task edit) |
| `TaskViewSet.perform_destroy` | `{instance.id}` + known successors |
| `DependencyViewSet.perform_create` | `{predecessor_id, successor_id}` |
| `DependencyViewSet.perform_destroy` | `{predecessor_id, successor_id}` |
| `BaselineViewSet.perform_create` | `None` (baselines don't mutate CPM inputs) |
| `MSProjectImportTask` | `None` (bulk — always full recompute) |
| `bulk task PATCH` endpoint | `set(ids_in_payload)` |

### Outbox — `ScheduleRequest` field addition

```python
class ScheduleRequest(models.Model):
    # ... existing fields ...
    changed_task_ids = JSONField(null=True, default=None)
    # null → full recompute; list → incremental candidate
```

Migration is **additive, nullable, no default backfill** — safe on live
PostgreSQL with `CONCURRENTLY`-compatible schema change.

Drain task (`drain_schedule_queue`) passes `changed_task_ids` into
`schedule(project, changed_task_ids=...)`. Existing outbox semantics unchanged
(partial unique constraints, dead-letter, `on_commit` dispatch).

### Coalescing

When multiple `ScheduleRequest` rows accumulate between drain runs for the same
project, the drain **unions** their `changed_task_ids` before dispatch. If any row
in the batch has `changed_task_ids=None`, the union collapses to `None` (full).
This keeps outbox semantics safe under rapid-fire edits.

### Correctness — the non-negotiable gate

**A new fuzz test is the release gate.**

```python
# packages/scheduler/tests/test_incremental_equivalence.py
@pytest.mark.parametrize("seed", range(1000))
def test_incremental_matches_full(seed):
    rng = random.Random(seed)
    project = generate_random_project(rng, task_count=rng.randint(10, 500))
    changed = rng.sample(project.tasks, k=rng.randint(1, 10))

    full_result = schedule(project)
    incremental_result = schedule(project, changed_task_ids={t.id for t in changed})

    assert_results_bit_exact(full_result, incremental_result)
```

`assert_results_bit_exact` compares every ES/EF/LS/LF/total_float/free_float/
is_critical and project_finish. Any divergence fails the run.

**1000 random seeds × 10–500 tasks × 1–10 changes** = enough coverage to catch
subgraph bugs. The test runs in CI on every scheduler PR and on nightly.

If the fuzz test ever fails in production telemetry (we add a sampled
shadow-compare in the drain task: 1% of runs do both full and incremental, log if
they diverge), the engine automatically falls back to full for that request and
emits a structured `scheduler.incremental.divergence` log.

### Performance target

- 500-task project + 5-task change: **< 200 ms p95** (current full: ~600 ms)
- 2,400-task project + 5-task change: **< 500 ms p95** (current full: ~15 s)
- Full-recompute perf unchanged.

Benchmark committed in `packages/scheduler/tests/test_benchmarks.py` with
`pytest-benchmark`. CI job `scheduler:bench` fails on > 20% regression.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Explicit `changed_task_ids` from callers** (chosen) | Correct by construction; easy to audit; unambiguous fallback | Every caller needs to know what changed |
| Signal-driven accumulation into outbox | No caller changes | Silent data corruption if a signal is missed or dispatched out of order; hidden coupling |
| Diff server_version between drain runs | No caller changes; uses existing field | Requires a "last-scheduled-version" checkpoint per project — new state to maintain; races between API writes and drain |
| Only optimize the CPM passes (keep full scope, faster algorithm) | No semantics change | Diminishing returns; most full-recompute cost is the writes, not the CPM math |
| Use Rust WASM `incremental_update` server-side via subprocess | Reuse existing Rust code | Process-spawn overhead per request (~50ms); Python↔Rust JSON serialization cost; two implementations still |

**Why not signal-driven?** See Marcus's quote above. Correctness is the point of
the scheduler. If the mechanism can silently omit a change, the whole value
proposition erodes.

## Consequences

### Easier
- Marcus's 2,400-task project becomes usable with PM-driven recalc
- PM-level edit feedback loop shrinks from "recalc kills my session" to
  "invisible, it just works"
- Monte Carlo simulation (which uses the same scheduler) also benefits when run
  over scenarios that only differ by a handful of tasks (future optimization)

### Harder
- Every future CPM caller must decide: do I know what changed? If yes, pass it;
  if no, pass `None`. Documented in `scheduling/services.py` docstring.
- Subgraph bugs are subtle — a missed descendant causes wrong dates. Mitigated by
  the fuzz test and the shadow-compare telemetry.
- `ScheduleRequest` rows have a new field; any external tooling reading them
  (there is none today) must handle it.

### Risks
- **Subgraph extraction bug**: the engine skips a task that should have been
  recomputed. **Mitigation**: 1000-seed fuzz test + 1% shadow-compare in
  production + automatic fallback on divergence.
- **Coalescing regression**: unioning multiple `changed_task_ids` lists produces
  a wrong set. **Mitigation**: coalescing happens at the drain task level with
  its own unit tests; any `None` in the batch degrades safely to full.
- **Performance regression of full recompute**: refactoring to support the new
  parameter introduces a slowdown in the unchanged-signature full path.
  **Mitigation**: `scheduler:bench` CI gate on full-path perf specifically.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `scheduler`, `api`
- **Migration required**: yes (`scheduling/0003_schedulerequest_changed_task_ids`
  — additive, nullable, no backfill; `atomic=False` + `CONCURRENTLY` if possible)
- **API changes**: no external surface change; internal `services.enqueue_recalculate`
  gains a keyword arg
- **OSS or Enterprise**: **OSS**

### Durable execution checklist

1. **Broker down at dispatch?** Outbox unchanged — `ScheduleRequest` rows
   persist, drain retries. Incremental field is just additional payload.
2. **New drain task needed?** No — existing `drain_schedule_queue` handles the
   new field. Coalescing logic added inside the same task.
3. **Orphan window?** Unchanged — 10 min per existing convention.
4. **Existing service layer?** Yes. `services.enqueue_recalculate()` is the sole
   entry point; direct `recalculate_schedule.delay()` calls are forbidden (as
   today).
5. **API response shape?** Unchanged — callers of mutations already get `202
   {"queued": true}` per existing outbox convention.
6. **Cleanup?** Existing `purge_old_schedule_requests` Beat task handles it
   — no change.

### Implementation order

1. Add `changed_task_ids` kwarg to `schedule()` with subgraph extraction; full
   path when `None`
2. Add fuzz test `test_incremental_equivalence.py` (1000 seeds)
3. Add bench test; update `scheduler:bench` CI to include 2,400-task incremental
4. Add `ScheduleRequest.changed_task_ids` + migration
5. Update `drain_schedule_queue` to pass the field; add coalescing + union logic
6. Update `services.enqueue_recalculate` signature; update all internal callers
7. Add 1% shadow-compare in drain task; structured log on divergence
8. Verify `regression-check` + `perf-check` + `migration-check` all green
9. Ship behind `SCHEDULER_INCREMENTAL_ENABLED` flag (default True); kill-switch
   if production divergence shows up

### Related ADRs

- ADR-0017: Celery Task Hardening — `recalculate_schedule` already has retry +
  time limits; unchanged
- ADR-0018: Idempotent Task Execution Framework — `recalculate_schedule` is
  already `@idempotent_task(on_contention="queue")`; unchanged
- ADR-0015: WASM CPM Engine — Rust `incremental_update` uses the same subgraph
  approach; conformance test coverage extends naturally to incremental
- ADR-0020: Long-Running Task Progress Tracking — scheduler runs are tracked in
  `TaskRun`; `result_summary.tasks_scheduled` reflects the incremental count
  when applicable
