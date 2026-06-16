# ADR-0142: Sync watermark column + CPM working-day index

## Status
Accepted

## Context
Two structural performance items the 2026-05-28 pre-release performance audit
deferred to 0.3 (#822). Both preserve existing outputs exactly — they are pure
hot-path optimizations, not behavior changes.

**P-05 — sync watermark.** Every sync pull
(`GET /api/v1/projects/{pk}/sync/`) computes its watermark `timestamp` with
`_snapshot_max_version()` (`apps/sync/views.py`) — a 12-table `UNION ALL` of
`MAX(server_version)` across every project-scoped synced table. Even with the
`(project, server_version)` indexes from #810 each pull issues 12 sub-selects; at
50 concurrent pulls/project that is ~600 fast-but-non-trivial index seeks per
second per project, all to read a single integer.

**P-07 — CPM working-day arithmetic.** `_working_days_between(start, end)`
(`packages/scheduler/src/trueppm_scheduler/engine.py`) is an `O(end − start)`
day-by-day Python loop. It is called per task from `_compute_floats` (twice per
successor link), so total float and free float computation is
`O(tasks · span)` — ~2.5M date operations on a 10k-task, one-year project.

P3M layer: Programs and Projects (OSS) — sync + the CPM engine.

## Decision

**P-05.** Add `Project.last_sync_version` (`BigIntegerField`, `editable=False`,
never sync-serialized). It caches `MAX(server_version)` over the project's synced
rows — exactly what the union returns. It is maintained by `post_save` receivers
on the **12 union-participating models**, each bumping the owning project:

```python
Project.objects.filter(pk=project_id).update(
    last_sync_version=Greatest(F("last_sync_version"), Value(instance.server_version))
)
```

`Greatest`/`F` make the update atomic under concurrent writes (the row lock on
the project serializes them), and it runs inside the same transaction as the
row save, so a rollback rolls the watermark back too. Migration **0082** adds the
column and back-fills it from the union for existing projects. The sync view
reads the column; `_snapshot_max_version()` is retained behind
`settings.SYNC_WATERMARK_USE_COLUMN` (default `True`) as a one-release fallback.

Three correctness constraints, all required to keep `column == union`:
- **Dependency has no receiver.** The union tracks dependencies via the
  *predecessor task's* version (`MAX(t.server_version)`), not
  `dependency.server_version`, so a dependency-only change must not move the
  watermark. (This already diverges from the *delta* query, which filters
  dependencies by their own `server_version` — a pre-existing discrepancy we
  preserve here and track separately as a follow-up; #822 is perf, not a sync
  correctness fix.)
- **Only the 12 union tables** get receivers. Other `VersionedModel` subclasses
  (e.g. `PulseResponse`, `RetroBoardItem`, `BacklogItem`, `ApiToken`) are not in
  the project sync union and must not bump it.
- **CPM outputs do not bump it.** Per ADR-0091 the CPM `bulk_update` deliberately
  bypasses `VersionedModel.save()`, so it emits no `post_save` and no
  `server_version` change — the watermark is therefore unaffected by recompute,
  matching the union.

A conformance test asserts `Project.last_sync_version == _snapshot_max_version()`
after touching each model type — the guard against signal/union drift. The
watermark is monotonic (`Greatest`), so a hard-delete of the current max row
leaves it unchanged where the union would drop; this is safe (a too-high
watermark only makes a client re-pull) and out of the sync protocol (which
soft-deletes).

**P-07.** Build a sorted `numpy` array of working-day **ordinals** once per
`schedule()` call (the CPM counterpart to monte_carlo's existing
`_build_working_day_index`) covering `[project_start, project_finish]`. Wrap it in
a `_WorkingDayCounter` whose `.between(start, end)` returns
`searchsorted(end) − searchsorted(start)` — `O(log n)` and byte-identical to the
scalar count of working days in `[start, end)`. `_compute_floats` uses the
counter; the scalar `_working_days_between` stays as the conformance reference and
the fallback when no counter is supplied. The Rust/WASM engine is unchanged: the
optimization changes how a count is computed, not the result, so cross-engine
conformance holds.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| P-05 column + signals (chosen) | 12 sub-selects → 1; atomic; transaction-safe | Signal registry must mirror the union (guarded by conformance test) |
| P-05 outbox / Celery bump | Decoupled | Watermark must be exact and immediate; async would let a pull read a stale value |
| P-05 trigger in `VersionedModel.save()` | Central | Base model can't cleanly resolve "owning project" per subclass; couples the base to Project |
| P-07 searchsorted index (chosen) | `O(log n)`, mirrors MC, identical output | One `O(span)` index build per call (amortized away by the per-task wins) |
| P-07 cumulative-count prefix array | `O(1)` lookup | Same asymptotics as build cost; more bespoke than the existing MC pattern |

## Consequences
- **Easier**: sync pulls read one integer column; CPM float computation drops
  from `O(tasks·span)` to `O(span + tasks·log span)`.
- **Harder**: a *new* table added to the sync union must also get a receiver —
  the conformance test fails loudly if it is forgotten.
- **Risks**: P-05 signal drift (mitigated by the conformance test + the
  `SYNC_WATERMARK_USE_COLUMN` fallback). P-07 index miscoverage (mitigated by the
  scalar fallback and the exact-equality conformance/float tests).

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (sync, projects), scheduler
- Migration required: yes — projects migration 0082 (field + data back-fill)
- API changes: no contract change — `timestamp` semantics are identical
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: N/A — the watermark update is a synchronous SQL UPDATE
   in the same transaction as the triggering save; no broker involved.
2. Drain task: N/A — no async work.
3. Orphan window: N/A — no outbox rows; the update commits atomically with the save.
4. Service layer: receivers in `apps/sync/receivers.py` (registered in
   `SyncConfig.ready()`); the engine change is pure-library in `engine.py`.
5. API response on best-effort dispatch: N/A — synchronous read of a column.
6. Outbox cleanup: N/A.
7. Idempotency: the `Greatest(F(...), Value(...))` update is idempotent — applying
   the same server_version twice is a no-op; replays cannot lower the watermark.
8. Dead-letter / failure handling: N/A — a failed watermark update fails the
   enclosing save's transaction, so the row and its watermark stay consistent.
