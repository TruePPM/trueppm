# ADR-0018: Idempotent Task Execution Framework

> **Note (2026-05-04, #316):** Throughout this ADR, "Redis" should be read as
> "Redis-compatible". TruePPM 0.1+ ships with [Valkey](https://valkey.io) (the
> BSD-licensed Linux Foundation fork of Redis); the `SET NX`-based lock,
> `redis-py` driver, and all timing arguments work unchanged because Valkey is
> wire-compatible with Redis 7.2.

## Status
Accepted (2026-05-31) — implemented in #316

## Context
TruePPM has two Celery tasks today: `recalculate_schedule` (with a hand-rolled
Redis SET NX lock and manual re-queue on collision) and `purge_old_history_records`
(no locking at all). As more tasks are added (webhooks, progress tracking, import/
export), every task will need the same boilerplate: acquire lock, extend it, handle
contention, release on completion.

The hand-rolled lock in `recalculate_schedule` has several limitations:
- No automatic lock extension — a long-running CPM calc can exceed the 300 s TTL
  and lose exclusivity while still running.
- The re-queue loop is unbounded (capped at 5 in #62, but still manual).
- Lock key uniqueness is not validated at import time — two tasks could
  accidentally share a key pattern and silently deadlock each other.
- Each new task must re-implement the same Redis lock/unlock/contention logic.

Issue #63 calls for a reusable `@idempotent_task` decorator that standardizes this
pattern across all Celery tasks.

## Decision
Create a `trueppm_api.core.idempotent` module with an `@idempotent_task` decorator
that wraps `@shared_task` and provides:

1. **Redis distributed lock** with configurable key template, TTL, and extension
   interval. Lock keys are formatted from task arguments (e.g.,
   `schedule_lock:{0}` where `{0}` is the first positional arg).

2. **Three contention strategies** (`on_contention` parameter):
   - `retry` — re-queue with exponential backoff (default for mutation tasks)
   - `skip` — log and discard (default for idempotent maintenance tasks)
   - `queue` — re-queue with fixed countdown (legacy compat with current behavior)

3. **Automatic lock extension** via a daemon thread that renews the lock at
   `lock_extend_interval` (default: TTL / 3). Uses a compare-and-extend Lua
   script to avoid extending a lock that was stolen.

4. **Lock key registry** — a module-level set that records all registered lock key
   templates. A duplicate template raises `ValueError` at import time, catching
   accidental collisions before runtime.

5. **Clean integration with Celery decorators** — the decorator passes through all
   `@shared_task` kwargs (bind, autoretry_for, retry_backoff, etc.) so it
   composes with the hardening from #62.

### Migration plan
- `recalculate_schedule` → `@idempotent_task(lock_key_template="schedule_lock:{0}", lock_ttl=300, on_contention="retry")`
- `purge_old_history_records` → `@idempotent_task(lock_key_template="history_purge", lock_ttl=600, on_contention="skip")`

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. python-redis-lock (redis-lock)** | Battle-tested, auto-extend built in | Adds a dependency; API doesn't map cleanly to Celery task lifecycle; no contention strategies |
| **B. Celery built-in `ensure_one` (proposed CEP)** | Native to Celery | Not shipped yet; no timeline; different semantics than what we need |
| **C. Keep hand-rolling per task** | No abstraction overhead | Boilerplate grows linearly; bugs in one copy don't get fixed everywhere |
| **D. Custom decorator (chosen)** | Fits our exact needs; zero new deps; testable in isolation | Must maintain ourselves; ~150 lines of code |

Option D wins: it is the minimum viable abstraction, adds no dependencies, and
centralizes a pattern that will be duplicated across every new task.

## Consequences
- **Easier**: Adding a new Celery task with idempotency guarantees becomes a
  one-line decorator. Contention handling is consistent and tested.
- **Easier**: Lock extension eliminates silent lock expiry on long-running tasks.
- **Easier**: Import-time registry catches accidental lock key collisions.
- **Harder**: Contributors must understand the decorator's semantics before
  writing raw Redis lock code (but that's the point — they shouldn't).
- **Risk**: The Lua compare-and-extend script must be correct; a bug could cause
  lock leaks. Mitigated by thorough unit tests with mock Redis.

## Implementation Notes
- P3M layer: Operations
- Affected packages: api
- Migration required: no (no model changes)
- API changes: no
- OSS or Enterprise: OSS
