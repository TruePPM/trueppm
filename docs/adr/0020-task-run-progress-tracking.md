# ADR-0020: Long-Running Task Progress Tracking

## Status
Accepted

## Context

TruePPM is adding operations that take seconds to minutes to complete: MS Project
import (#10), Monte Carlo simulation (#12), and future bulk operations. Today CPM
recalculation broadcasts `cpm_queued`/`cpm_complete`/`cpm_error` WebSocket events but
leaves no DB record. Users have no way to:
- See whether a long operation is still running or silently failed
- Check the result after navigating away
- Cancel a runaway import without restarting the server
- Audit who initiated what operation and when

The frontend needs a progress bar in context (e.g., the import dialog) and a subtle
global indicator for background operations. VoC panel: 4.4/10 — infrastructure UX;
the import dialog progress bar is the highest-value surface.

## Decision

Introduce a `taskruns` Django app with a `TaskRun` model and `TaskRunTracker` context
manager. All long-running Celery tasks wrap their body in `TaskRunTracker`, which
persists status to PostgreSQL and broadcasts WebSocket events in real time.

### `TaskRun` model

```python
class TaskRun(models.Model):
    id              = UUIDField(primary_key=True, default=uuid4, editable=False)
    task_name       = CharField(max_length=255)          # e.g. "scheduling.recalculate"
    celery_task_id  = CharField(max_length=255, db_index=True)
    project         = FK(Project, CASCADE, null=True, related_name="task_runs")
    initiated_by    = FK(User, SET_NULL, null=True, related_name="task_runs")
    status          = CharField(choices=TaskRunStatus, default=PENDING)
    progress_pct    = SmallIntegerField(null=True)        # 0-100
    progress_msg    = TextField(blank=True)
    result_summary  = JSONField(null=True)               # structured audit artifact
    error_detail    = TextField(blank=True)
    created_at      = DateTimeField(auto_now_add=True)
    started_at      = DateTimeField(null=True)
    completed_at    = DateTimeField(null=True)

    class Meta:
        indexes = [Index(fields=["project", "status", "created_at"],
                         name="taskrun_project_status_created_idx")]
        ordering = ["-created_at"]
```

`TaskRun` does NOT extend `VersionedModel` — it is a server-side audit record, not
synced to mobile.

### `TaskRunTracker` context manager

```python
with TaskRunTracker(self, project_id=project_id, task_name="scheduling.recalculate",
                    initiated_by_id=None) as tracker:
    tracker.update(10, "Parsing file...")
    tracker.update(80, "Creating tasks...")
    tracker.set_result({"tasks_created": 487})
```

- Creates the `TaskRun` record on `__enter__`, sets `started_at` and status=RUNNING.
- `tracker.update(pct, msg)` — debounced to 1 write/second using Redis key
  `task_run_debounce:{id}` (stores last-update epoch float). Broadcasts
  `task_run_progress` WebSocket event.
- On success `__exit__`: status=SUCCESS, `completed_at` set, broadcasts
  `task_run_completed`.
- On exception `__exit__`: status=FAILED, `error_detail` set, broadcasts
  `task_run_failed`.
- Cancellation: cancel endpoint writes Redis key `task_run_cancel:{id}`; `tracker.update()`
  checks this key and raises `TaskCancelled`, which the `__exit__` handler catches and
  sets status=CANCELLED, broadcasts `task_run_cancelled`.

### REST endpoints

| Method | Path | Permission |
|--------|------|------------|
| GET | `/api/v1/projects/{id}/task-runs/` | Viewer+ |
| GET | `/api/v1/task-runs/{id}/` | project member of run's project |
| POST | `/api/v1/task-runs/{id}/cancel/` | Admin+ |
| GET | `/api/v1/task-runs/active/` | authenticated; scoped to user's project memberships |

`/task-runs/active/` returns PENDING + RUNNING runs across all projects the requesting
user is a member of. It does NOT aggregate across all projects — it is a personal
in-flight view, not a PMO rollup.

### WebSocket events

All broadcast on `project_{project_pk}` via `broadcast_board_event`. Additionally, the
existing `ProjectConsumer` is extended to also join the `user_{user_pk}` group on
connect, enabling personal notifications for runs on projects the user has open.

| Event type | When | Payload additions |
|------------|------|-------------------|
| `task_run_started` | Tracker `__enter__` | `task_run_id`, `task_name`, `project_id` |
| `task_run_progress` | `tracker.update()` | `task_run_id`, `pct`, `msg` |
| `task_run_completed` | Success exit | `task_run_id`, `result_summary` |
| `task_run_failed` | Exception exit | `task_run_id`, `error_detail` |
| `task_run_cancelled` | Cancellation | `task_run_id` |

`recalculate_schedule` is migrated to use `TaskRunTracker`. The existing `cpm_queued`,
`cpm_complete`, and `cpm_error` events are replaced by the standard `task_run_*` events
carrying the same CPM payload in `result_summary`.

### Auto-purge

A nightly Celery beat task in `taskruns/tasks.py` purges completed/failed/cancelled
runs older than `TASK_RUN_RETENTION_DAYS` (default 30, configurable in settings).

### Frontend

- **Import dialog**: inline `ProgressBar` component driven by a `useTaskRun(id)` hook
  that subscribes to `task_run_*` events on the project WebSocket.
- **App shell header**: `TaskRunIndicator` — a subtle spinner badge on the TopBar that
  counts active runs. Collapsed by default; click opens a `TaskRunDrawer` listing
  recent runs. Hidden for users with no active runs. Role-gated: visible to Member+,
  hidden for pure Viewer sessions (VoC feedback: Viewers and execs don't need this).
- `useTaskRun(id)` hook: subscribes to WS events for a specific `task_run_id`, falls
  back to polling `/api/v1/task-runs/{id}/` at 2s interval if WS is unavailable.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Celery result backend (Redis) | Zero new models; built-in | No project-scoping; ephemeral; no audit trail; no cancellation signal |
| Server-Sent Events (SSE) | Simple; HTTP/1.1 compatible | Can't reuse existing WS connection; separate auth path |
| Polling only (no WS) | Simpler frontend | Latency; polling N active runs creates N×polling_interval requests |
| `task_run_*` events as new WS message type (not reusing `board.event`) | Cleaner separation | Requires consumer protocol change; breaks existing clients |

Chose PostgreSQL + `board.event` channel reuse: consistent with existing patterns
(`broadcast_board_event` is already used for all mutations), gives persistence for
audit, and adds minimal operational complexity.

## Consequences

- **Easier**: Long-running operations are observable; import/simulation failures are
  diagnosable from the UI without checking server logs; cancel is self-service.
- **Harder**: Every new long-running task must opt in to `TaskRunTracker`. Tasks that
  don't opt in will have no progress visibility — this must be documented as a
  convention.
- **Risk**: Debounce logic adds a Redis dependency inside task execution. If Redis is
  unavailable mid-task, the task should continue (debounce failure is non-fatal).
- **Enterprise extension point**: `TaskRun.result_summary` is a JSONField — enterprise
  can store workflow stage payloads here without a schema change. A `workflow_run` FK
  can be added via an enterprise migration without touching OSS.

## Implementation Notes

- P3M layer: Operations (single-project execution tracking)
- Affected packages: `api`, `web`
- Migration required: yes (new `taskruns` app, `0001_initial`)
- API changes: yes — 4 new endpoints; `recalculate_schedule` WebSocket event types
  change from `cpm_queued/complete/error` to `task_run_started/completed/failed`
- OSS or Enterprise: OSS (`trueppm-suite`)
- `TASK_RUN_RETENTION_DAYS` setting added to `settings/base.py` (default 30)
- `ProjectConsumer` gains `user_{user_pk}` group membership on connect
