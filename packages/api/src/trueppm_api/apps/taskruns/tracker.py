"""TaskRunTracker — context manager for reporting Celery task progress.

Usage inside a Celery task::

    @shared_task(bind=True)
    def import_mpp(self, project_id, file_id):
        with TaskRunTracker(self, project_id=project_id,
                            task_name="import.mpp") as tracker:
            tracker.update(10, "Parsing MPP file...")
            tracker.update(80, "Creating tasks...")
            tracker.set_result({"tasks_created": 487})

Progress updates are debounced to at most 1 DB write + WebSocket broadcast per second,
using a Redis key to track the last-update timestamp.

Cancellation is signalled by writing a Redis key (set by the cancel API endpoint).
The tracker checks this key on every ``update()`` call and raises ``TaskCancelled``
if found, which the context manager catches and marks the run CANCELLED.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

# Module-level import so tests can patch trueppm_api.apps.taskruns.tracker.broadcast_board_event.
from trueppm_api.apps.sync.broadcast import broadcast_board_event

logger = logging.getLogger(__name__)

# Redis key patterns (both expire automatically).
_DEBOUNCE_KEY = "task_run_debounce:{task_run_id}"
_CANCEL_KEY = "task_run_cancel:{task_run_id}"
_DEBOUNCE_TTL = 10  # seconds — key expires shortly after task completes
_CANCEL_TTL = 300  # seconds


class TaskCancelled(Exception):
    """Raised inside a task when a cancellation signal is detected."""


class TaskRunProjectGone(Exception):
    """Raised by ``TaskRunTracker.__enter__`` when the task's project no longer exists.

    A queued message can outlive its project (deleted while the task waited in the
    broker or the lock-retry loop, or a database reset under a persistent queue).
    There is nothing to track or do, so callers exit cleanly via
    ``ProjectGoneGuard`` rather than retrying or recording a failure.
    """


class ProjectGoneGuard:
    """Context manager that turns ``TaskRunProjectGone`` into a clean early exit.

    Put it *before* the tracker in the same ``with`` statement so the exception
    raised by the tracker's ``__enter__`` is suppressed and the body is skipped::

        guard = ProjectGoneGuard("import.csv", project_id)
        with guard, TaskRunTracker(...) as tracker:
            ...
        if guard.triggered:
            return {"skipped": True}

    Only an exception from ``__enter__`` can be ``TaskRunProjectGone``, so a real
    failure in the body is never swallowed.
    """

    def __init__(self, task_name: str, project_id: Any) -> None:
        self._task_name = task_name
        self._project_id = project_id
        self.triggered = False

    def __enter__(self) -> ProjectGoneGuard:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: object,
    ) -> bool:
        if exc_type is not None and issubclass(exc_type, TaskRunProjectGone):
            self.triggered = True
            logger.info(
                "%s: project %s no longer exists; skipping stale task",
                self._task_name,
                self._project_id,
            )
            return True
        return False


class TaskRunTracker:
    """Context manager that creates/updates a TaskRun record and broadcasts events.

    Args:
        celery_task: The bound Celery task instance (``self`` inside the task).
        project_id: UUID string of the associated Project, or None for global tasks.
        task_name: Human-readable identifier (e.g. ``"scheduling.recalculate"``).
        initiated_by_id: PK of the user who triggered the task, or None.
    """

    def __init__(
        self,
        celery_task: Any,
        *,
        project_id: str | None = None,
        task_name: str = "",
        initiated_by_id: Any = None,
    ) -> None:
        self._celery_task = celery_task
        self._project_id = project_id
        self._task_name = task_name or celery_task.name
        self._initiated_by_id = initiated_by_id
        self._task_run_id: str | None = None
        self._result: dict[str, Any] | None = None
        self._redis: Any = None

    # ------------------------------------------------------------------
    # Context manager protocol
    # ------------------------------------------------------------------

    def __enter__(self) -> TaskRunTracker:
        from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus

        # A queued message can outlive its project; inserting a TaskRun for it would
        # raise a raw FK IntegrityError and kill the task with a traceback (#4751).
        # Check first for the common case, then translate the FK failure for the
        # race where the project is deleted between the check and the insert. The
        # insert runs in a savepoint so the failure cannot poison a surrounding
        # transaction.
        if self._project_id is not None and not self._project_exists():
            raise TaskRunProjectGone(self._project_id)

        try:
            with transaction.atomic():
                task_run = TaskRun.objects.create(
                    task_name=self._task_name,
                    celery_task_id=self._celery_task.request.id or "",
                    project_id=self._project_id,
                    initiated_by_id=self._initiated_by_id,
                    status=TaskRunStatus.RUNNING,
                    started_at=timezone.now(),
                )
        except IntegrityError:
            if self._project_id is not None and not self._project_exists():
                raise TaskRunProjectGone(self._project_id) from None
            raise
        self._task_run_id = str(task_run.pk)

        self._redis = self._get_redis()

        self._broadcast(
            "task_run_started",
            {
                "task_run_id": self._task_run_id,
                "task_name": self._task_name,
                "project_id": self._project_id,
            },
        )
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: object,
    ) -> bool:
        from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus

        if self._task_run_id is None:
            return False

        task_run = TaskRun.objects.filter(pk=self._task_run_id).first()
        if task_run is None:
            return False

        now = timezone.now()

        if exc_type is TaskCancelled:
            task_run.status = TaskRunStatus.CANCELLED
            task_run.completed_at = now
            task_run.save(update_fields=["status", "completed_at"])
            self._cleanup_redis()
            self._broadcast("task_run_cancelled", {"task_run_id": self._task_run_id})
            return True  # suppress exception

        if exc_val is not None:
            task_run.status = TaskRunStatus.FAILED
            task_run.error_detail = str(exc_val)
            task_run.completed_at = now
            task_run.save(update_fields=["status", "error_detail", "completed_at"])
            self._cleanup_redis()
            self._broadcast(
                "task_run_failed",
                {
                    "task_run_id": self._task_run_id,
                    "error_detail": str(exc_val),
                },
            )
            return False  # re-raise

        task_run.status = TaskRunStatus.SUCCESS
        task_run.progress_pct = 100
        task_run.result_summary = self._result
        task_run.completed_at = now
        task_run.save(
            update_fields=[
                "status",
                "progress_pct",
                "result_summary",
                "completed_at",
            ]
        )
        self._cleanup_redis()
        self._broadcast(
            "task_run_completed",
            {
                "task_run_id": self._task_run_id,
                "result_summary": self._result,
            },
        )
        return False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(self, pct: int, msg: str = "") -> None:
        """Report progress.  Debounced to at most 1 write/second.

        Raises:
            TaskCancelled: if a cancel signal has been set for this run.
        """
        if self._task_run_id is None:
            return

        # Check for cancellation signal first.
        self._check_cancelled()

        # Debounce: skip if updated less than 1s ago.
        if self._debounced():
            return

        from trueppm_api.apps.taskruns.models import TaskRun

        TaskRun.objects.filter(pk=self._task_run_id).update(
            progress_pct=pct,
            progress_msg=msg,
        )
        self._broadcast(
            "task_run_progress",
            {
                "task_run_id": self._task_run_id,
                "pct": pct,
                "msg": msg,
            },
        )

    def set_result(self, result: dict[str, Any]) -> None:
        """Store the result summary to be saved on successful exit."""
        self._result = result

    @property
    def task_run_id(self) -> str | None:
        """UUID string of the active TaskRun, available after __enter__."""
        return self._task_run_id

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _project_exists(self) -> bool:
        from trueppm_api.apps.projects.models import Project

        if self._project_id is None:
            return True  # global task: no project to be gone
        return Project.objects.filter(pk=self._project_id).exists()

    def _get_redis(self) -> Any:
        try:
            from trueppm_api.core import valkey

            return valkey.client(valkey.DB_CELERY, decode_responses=True)
        except Exception:
            return None

    def _check_cancelled(self) -> None:
        """Raise ``TaskCancelled`` if a cancel signal is set; no-op if Redis is down."""
        if self._redis is None:
            return
        cancel_key = _CANCEL_KEY.format(task_run_id=self._task_run_id)
        try:
            if self._redis.exists(cancel_key):
                raise TaskCancelled()
        except TaskCancelled:
            raise
        except Exception:
            pass  # Redis unavailable — continue without cancel check

    def _debounced(self) -> bool:
        """Return ``True`` when the last write was <1s ago (skip this update).

        Records the current timestamp when the update is allowed to proceed. If
        Redis is unavailable the update is never debounced.
        """
        if self._redis is None:
            return False
        debounce_key = _DEBOUNCE_KEY.format(task_run_id=self._task_run_id)
        try:
            now_ts = time.monotonic()
            last_ts_bytes = self._redis.get(debounce_key)
            if last_ts_bytes is not None:
                last_ts = float(last_ts_bytes)
                if now_ts - last_ts < 1.0:
                    return True
            self._redis.set(debounce_key, now_ts, ex=_DEBOUNCE_TTL)
        except Exception:
            pass  # Redis unavailable — proceed without debounce
        return False

    def _cleanup_redis(self) -> None:
        if self._redis is None or self._task_run_id is None:
            return
        try:
            debounce_key = _DEBOUNCE_KEY.format(task_run_id=self._task_run_id)
            cancel_key = _CANCEL_KEY.format(task_run_id=self._task_run_id)
            self._redis.delete(debounce_key, cancel_key)
        except Exception:
            # Best-effort teardown; failure must not crash the tracker (keys carry a TTL)
            pass

    def _broadcast(self, event_type: str, payload: dict[str, Any]) -> None:
        if self._project_id is None:
            return
        # Defer the broadcast to commit (#1323). The tracker runs in a Celery task
        # with no ambient transaction today, so on_commit fires the callback
        # immediately and behavior is unchanged — but if a future caller ever runs
        # tracker.update() inside transaction.atomic(), this guarantees peers never
        # see a progress event for a write that then rolls back. Snapshot to plain
        # locals and keep the best-effort guard *inside* the deferred callable so a
        # commit-time channel-layer failure is still swallowed, not raised.
        project_id = self._project_id

        def _emit() -> None:
            try:
                broadcast_board_event(
                    project_id=project_id,
                    event_type=event_type,
                    payload=payload,
                )
            except Exception as exc:
                logger.warning("TaskRunTracker: broadcast failed: %s", exc)

        transaction.on_commit(_emit)
