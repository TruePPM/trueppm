# ADR-0197: Task/Dependency Tombstone Retention Window

## Status
Accepted

## Context

`reap_domain_tombstones` (`packages/api/src/trueppm_api/apps/sync/tasks.py`) hard-deletes
soft-deleted (`is_deleted=True`) `VersionedModel` rows nightly via Celery Beat. Each model
in `_TOMBSTONE_MODEL_REGISTRY` is paired with an `age_field` — a `DateTimeField` used to
gate reap eligibility on `TRUEPPM_TOMBSTONE_RETENTION_DAYS` (default 90 days). `Risk` and
`Sprint` carry `updated_at` (`auto_now=True`) and are correctly gated. `Task` and
`Dependency` — both `VersionedModel` subclasses with only `deleted_version`, no
`updated_at`/`deleted_at` — register `age_field=None`, meaning every soft-deleted Task or
Dependency row in a live project is eligible for hard deletion on the very next nightly run.

The offline mobile sync pull returns tombstones only for rows still present with
`is_deleted=True`. A client that is offline when a delete happens, and does not reconnect
before the next nightly reap, never receives the tombstone: the deleted task or dependency
edge becomes a permanent phantom row on that device, diverging from server state forever.
This directly contradicts the offline-first sync design (WatermelonDB-compatible delta with
tombstones) — Task and Dependency are the two models most central to the schedule, and
they are exactly the two with zero grace period. The existing code comment ("safe in
practice … fires well after mobile clients have synced") is an unverified assumption, not a
guarantee.

Filed as issue #1567 (2026-07-02 quality audit sweep, `fable-audit-20260702-quality`,
severity: high, milestone 0.4). The issue's own suggested fix — mirror
`TaskAttachment.deleted_at` — is the audit-confirmed direction; this ADR records why that
direction is correct and rules out the alternative floated in the issue body.

**P3M layer:** Programs and Projects (task/dependency lifecycle within a single project's
schedule) and Operations (the nightly reap job itself). OSS — offline sync and CPM data
integrity are core adoption-path guarantees, not portfolio governance.

## Decision

Add a nullable `deleted_at = models.DateTimeField(null=True, blank=True)` to `Task` and to
`Dependency`, stamped only inside each model's `soft_delete()` override (never touched by an
ordinary `save()`), mirroring the existing `TaskAttachment.deleted_at` pattern exactly:

- `Task.soft_delete()` already overrides the base to cascade-delete dependency edges and
  `is_subtask` children; it now also sets `self.deleted_at = timezone.now()` before
  delegating to `VersionedModel.soft_delete()`, which performs the actual `save()`.
- `Dependency` gains a new `soft_delete()` override (it previously relied on the base
  `VersionedModel.soft_delete()` directly) that stamps `deleted_at` the same way.
- `_TOMBSTONE_MODEL_REGISTRY` in `sync/tasks.py` registers `"deleted_at"` as the `age_field`
  for both Task and Dependency, so they are now gated by the same
  `TRUEPPM_TOMBSTONE_RETENTION_DAYS` setting that already protects Risk and Sprint — no new
  setting, no new Beat entry, no schema beyond the two nullable columns.

Cascade soft-deletes need no special propagation logic: each cascaded row (dependency edge,
subtask child) calls its own `soft_delete()` — which is exactly how the existing cascade
already tombstones each row for the sync endpoint — so each cascaded row independently
stamps its own `deleted_at` at the moment *it* is soft-deleted. No parent→child timestamp
copying is needed or wanted; a subtask soft-deleted a moment after its parent should get its
own grace window measured from its own deletion, not an inherited one.

`deleted_at` is a plain nullable `DateTimeField`, not `auto_now`/`auto_now_add`: it must stay
null for the entire live lifetime of the row (an ordinary `save()` must never touch it) and
be set exactly once, at the moment of soft-delete — `auto_now` would stamp it on every save,
`auto_now_add` only fires on INSERT. Explicit assignment in `soft_delete()` is the only
mechanism that expresses "set once, at delete time."

No dedicated index on `deleted_at` is added. The reap query filters
`is_deleted=True AND deleted_at < cutoff`; `is_deleted` already carries `db_index=True` on
`VersionedModel` and is highly selective (soft-deleted rows are a small minority of any live
project), so the `deleted_at` comparison runs against an already-narrow row set. This matches
the existing precedent: `Risk.updated_at` and `Sprint.updated_at` have no dedicated index
either, and both models pass the same nightly reap today at production-representative scale.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. `deleted_at` DateTimeField, stamped in `soft_delete()`, registered as `age_field`** (chosen) | Mirrors an established, already-shipped pattern (`TaskAttachment.deleted_at`); zero new settings or Beat entries; the registry's existing `age_field` mechanism handles it with one line per model; explicit and easy to reason about | Two new nullable columns on two large, high-churn tables (migration-safe: nullable, no default computation, no backfill required — see Implementation Notes) |
| Gate reap on `deleted_version` vs. a per-project last-synced watermark | No new column | Requires tracking a durable "minimum client watermark" per project across *all* devices that might be offline — a much bigger feature (open-ended: what counts as "synced," how long does an abandoned device's watermark block reap forever) for a problem a simple time-based grace window already solves. The registry has no concept of per-project watermarks today; introducing one here would be scope creep on a high-severity but narrowly-scoped fix. |
| Leave `age_field=None`, shorten "safe in practice" to a documented risk acceptance | Zero code change | Does not fix the underlying bug; offline clients silently diverge — the entire point of the issue is that this assumption is unverified and wrong for the platform's own stated offline-first guarantee |
| Add `updated_at` (`auto_now=True`) instead of `deleted_at` | Slightly less code (no explicit stamping needed) | `Task` saves are dominated by unrelated field churn (status transitions, CPM writeback, drag-reschedule) — `updated_at` would be refreshed by every one of those, meaninglessly resetting the retention clock on every edit and making "how long has this tombstone existed" unanswerable from the column. `deleted_at` (set once, at delete) is the correct semantic; `Risk`/`Sprint` can safely use `updated_at` because their save patterns are not similarly dominated by high-frequency unrelated writes close to delete time in the same way, and because the risk of a false-early reap there is bounded by the same 90-day default either way. |

## Consequences

- **Easier:** Task/Dependency tombstones now reliably survive the same grace window Risk
  and Sprint already get; an offline mobile client has up to
  `TRUEPPM_TOMBSTONE_RETENTION_DAYS` (default 90 days) to reconnect and receive a delete
  before the row is purged, closing the offline-divergence gap the audit flagged.
- **Easier:** future `VersionedModel` subclasses added to the registry have two proven
  `age_field` patterns to choose from (`updated_at` for low-churn models, `deleted_at` for
  high-churn ones), documented in the registry's own comment block.
- **Harder:** any code path that directly mutates `Task.is_deleted` / `Dependency.is_deleted`
  via a bulk `.update()` (bypassing `soft_delete()`) will leave `deleted_at` null, and a null
  `deleted_at` never satisfies `deleted_at__lt=cutoff` — such a row would never be reaped
  (fail-safe, not fail-dangerous, but worth flagging). A repo-wide grep at implementation
  time found no production code path that does this for Task or Dependency; test fixtures
  that bypass `soft_delete()` for speed must now also set `deleted_at` when simulating an
  aged tombstone.
- **Risks:** none beyond the two-column migration itself (mitigated below); the change is
  purely additive to model state and a one-line registry swap — no behavior change to any
  other model, no API surface change, no new Celery task.

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: api
- Migration required: yes — two nullable `DateTimeField` columns (`Task.deleted_at`,
  `Dependency.deleted_at`), no default requiring backfill, safe as a single additive
  migration (`makemigrations projects`) per the repo's migration discipline (batch the
  model edit, generate once).
- API changes: no — `deleted_at` is an internal reap bookkeeping field, not exposed on
  `TaskSerializer`/`DependencySerializer` (mirrors `TaskAttachment.deleted_at`, which is
  likewise not client-writable API surface beyond soft-delete's own effect).
- OSS or Enterprise: OSS (`packages/api`) — offline sync correctness for the core
  Project/Task/Dependency entities.

### Durable Execution
1. Broker-down behaviour: N/A — no new dispatch path. `reap_domain_tombstones` already
   exists as a Beat-scheduled `@idempotent_task`; this change only alters which rows its
   existing query selects.
2. Drain task: N/A — reuses the existing `reap_domain_tombstones` nightly task; no new
   task category is introduced.
3. Orphan window: N/A — not an outbox/on_commit dispatch path; the reap task reads
   `is_deleted`/`deleted_at` directly from committed rows only (it runs on its own Beat
   cadence, not in response to a write).
4. Service layer: N/A — no new dispatch; `Task.soft_delete()` / `Dependency.soft_delete()`
   are the existing service-layer entry points, now stamping one additional field each.
5. API response on best-effort dispatch: N/A — no API-triggered async dispatch is added.
6. Outbox cleanup: N/A — no outbox row is introduced.
7. Idempotency: unchanged — `reap_domain_tombstones` is already
   `@idempotent_task(lock_key_template="reap_domain_tombstones", on_contention="skip")`; a
   `.delete()` on an already-hard-deleted queryset is naturally a no-op, so re-running the
   task (or running it twice concurrently, guarded by the lock) is safe.
8. Dead-letter / failure handling: unchanged from the existing task — a permanent failure
   surfaces via normal Celery task-failure logging/alerting; there is no new failure mode
   introduced by adding a column to the filter.
