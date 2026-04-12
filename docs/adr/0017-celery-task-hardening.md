# ADR-0017: Celery Task Hardening — Retry Policies, Time Limits, and Dead-Letter Tracking

## Status
Proposed

## Context
TruePPM has two Celery tasks: `recalculate_schedule` (CPM engine, triggered by task/dependency mutations) and `purge_old_history_records` (nightly beat job). Neither has retry policies, time limits, or failure tracking.

Current gaps:
- **No retry policy**: `recalculate_schedule` catches all exceptions and swallows them after logging + broadcasting `cpm_error`. The lock-collision re-queue loop is unbounded.
- **No time limits**: a hung CPM computation or a slow purge job blocks the worker indefinitely.
- **No dead-letter tracking**: when a task fails permanently, the failure is logged to stdout and lost. There is no persistent record, no admin visibility, and no way to retry.
- **No lifecycle signals**: enterprise cannot observe task execution without patching OSS code.

This is the foundation layer that enterprise durable execution (approval workflows, integration sync) builds on. The Operations P3M layer — task execution reliability is an operational concern.

## Decision

### 1. Retry policies on all tasks

| Task | `autoretry_for` | `max_retries` | `retry_backoff` | `retry_backoff_max` | `retry_jitter` |
|------|-----------------|---------------|-----------------|---------------------|----------------|
| `recalculate_schedule` | `ConnectionError`, `redis.ConnectionError`, `OperationalError` | 3 | 30 (seconds) | 300 | True |
| `purge_old_history_records` | `ConnectionError`, `OperationalError` | 3 | 60 | 600 | True |

Non-retriable exceptions (`CyclicDependencyError`, `Project.DoesNotExist`, `ValidationError`) are NOT in `autoretry_for` — they fail immediately and write to `FailedTask`.

The lock-collision re-queue in `recalculate_schedule` gets a `_MAX_REQUEUE = 5` counter passed via task headers to prevent infinite loops.

### 2. Time limits

| Task | `soft_time_limit` | `time_limit` |
|------|-------------------|-------------|
| `recalculate_schedule` | 480s | 600s |
| `purge_old_history_records` | 300s | 360s |

`SoftTimeLimitExceeded` handler: log context (task_id, project_id, attempt), release Redis lock if held, broadcast `cpm_error` with `reason: "timeout"`, write to `FailedTask`.

### 3. FailedTask model (dead-letter tracking)

Location: `trueppm_api.apps.scheduling.models`

```
FailedTask
  id              UUID PK (default uuid4)
  task_name       CharField(255)           -- Celery task name
  task_id         CharField(255, unique)   -- Celery task ID
  args            JSONField(default=list)
  kwargs          JSONField(default=dict)
  exception_type  CharField(255)
  exception_message TextField
  traceback       TextField
  failure_count   PositiveIntegerField(default=1)
  first_failed_at DateTimeField(auto_now_add)
  last_failed_at  DateTimeField(auto_now)
  status          CharField: pending_retry | dead | dismissed | retried

  indexes:
    - (status, last_failed_at) -- admin listing
    - task_name                -- filtering
```

Does NOT inherit `VersionedModel` — not synced to mobile, not part of the project data graph. Plain `models.Model` with UUID PK for consistency.

On final retry exhaustion: write `FailedTask(status="dead")`, broadcast `task_dead_lettered` WebSocket event on the `system` channel group.

### 4. Admin API

```
GET    /api/v1/admin/failed-tasks/          -- list (Viewer+)
GET    /api/v1/admin/failed-tasks/{id}/     -- detail (Viewer+)
POST   /api/v1/admin/failed-tasks/{id}/retry/   -- re-enqueue (Admin+)
POST   /api/v1/admin/failed-tasks/{id}/dismiss/  -- mark dismissed (Admin+)
```

Retry re-enqueues the original task with the stored args/kwargs and sets `status=retried`. Dismiss sets `status=dismissed`. Neither deletes the record.

### 5. Task lifecycle signals

Location: `trueppm_api.apps.scheduling.signals`

```python
celery_task_started   = Signal()   # sender=task_name, task_id, args, kwargs
celery_task_succeeded = Signal()   # sender=task_name, task_id, runtime_seconds
celery_task_failed    = Signal()   # sender=task_name, task_id, exception, traceback
celery_task_retried   = Signal()   # sender=task_name, task_id, attempt, exception
```

Wired via Celery's `task_prerun`, `task_postrun`, `task_failure`, and `task_retry` framework signals in `SchedulingConfig.ready()`. Enterprise connects receivers for PagerDuty/Slack alerting without modifying OSS code.

### 6. Structured logging

All task entry/exit points log with:
```python
logger.info("task.started", extra={"task_id": ..., "project_id": ..., "attempt": ...})
```

Using `structlog` is deferred — plain `logging` with `extra` dict is sufficient for alpha and compatible with any log aggregator.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **django-celery-results** for failure tracking | Zero model code; built-in admin | Stores ALL results (not just failures); large table; no dead-letter semantics; extra dependency |
| **Redis-only failure tracking** (key per failure) | No migration; fast | Volatile (eviction); no queryable admin; no audit trail |
| **Custom `FailedTask` model** (chosen) | Purpose-built; only stores failures; queryable; admin API; no new dependencies | Migration required; custom code to maintain |

| Option | Pros | Cons |
|--------|------|------|
| **Celery signals** for lifecycle events | Built into Celery; fires automatically | Not Django signals; enterprise must import from Celery; different wiring pattern than existing `risk_changed`/`task_status_changed` |
| **Django signals bridged from Celery signals** (chosen) | Consistent with existing signal pattern; enterprise uses same `Signal.connect()` API | Thin bridge code in `SchedulingConfig.ready()` |

## Consequences

- **Easier**: Transient failures (DB connection blips, Redis timeouts) self-heal via retry. Permanent failures are visible in the admin API. Enterprise can observe all task lifecycle events via Django signals.
- **Harder**: Adding a new Celery task requires remembering to set retry/time-limit parameters (mitigated by a base task class or decorator).
- **Risks**: Retry storms if a systemic issue (e.g., DB down) causes all tasks to retry simultaneously. Mitigated by jitter + backoff + max_retries cap.

## Implementation Notes
- P3M layer: Operations
- Affected packages: api (scheduling app)
- Migration required: yes (FailedTask model)
- API changes: yes (admin failed-tasks endpoint)
- OSS or Enterprise: OSS (trueppm-suite)
- Existing beat schedule format in `settings/base.py` needs fixing — currently uses a raw dict instead of `celery.schedules.crontab`
