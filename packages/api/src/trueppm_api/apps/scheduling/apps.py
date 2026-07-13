"""App config for scheduling."""

from __future__ import annotations

import logging
import time
from typing import Any

from django.apps import AppConfig

logger = logging.getLogger(__name__)

# Wall-clock start time (time.monotonic(), immune to system clock adjustments) for
# each in-flight Celery task execution, keyed by task_id. Populated in
# _on_task_prerun and consumed (popped) in _on_task_postrun — that pair always
# brackets one execution 1:1, including retried and failed ones, so duration is
# available for every outcome, not just success (#1917). Celery itself does not
# set a usable `.runtime` attribute on the request for anything but the success
# path, which is why this is timed here instead of read off `task.request`.
_task_start_times: dict[str, float] = {}


class SchedulingConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.scheduling"

    def ready(self) -> None:
        """Bridge Celery framework signals to Django signals.

        Enterprise packages connect receivers to the Django signals in
        scheduling.signals — they never need to import from Celery directly.

        Every ``.connect(...)`` below now passes ``weak=False`` (#1917 fix). Celery's
        ``Signal.connect`` defaults to a *weak* reference to the receiver, and the
        four ``_on_task_*`` functions are closures local to this method call — with
        no other strong reference anywhere, they were garbage-collected the moment
        ``ready()`` returned, silently turning the whole Celery→Django task-lifecycle
        bridge into dead code (confirmed via ``task_prerun.receivers`` showing a
        dead weakref immediately after startup). None of ``celery_task_started`` /
        ``_succeeded`` / ``_failed`` / ``_retried`` were ever actually being sent in
        a real worker, which is why #1917 found no start/success/retry log lines to
        begin with — this was the root cause, not just a missing receiver. A stable
        ``dispatch_uid`` per connect call is required alongside ``weak=False``: without
        it, a second ``ready()`` call (the test runner / autoreloader can trigger one)
        would register a *second*, now-permanent strong-ref closure rather than being
        recognized as the same receiver, doubling every log line and metric sample
        from then on.
        """
        from celery.signals import task_failure, task_postrun, task_prerun, task_retry

        # Register the OSS dead-letter alerting receiver (ADR-0084) and the
        # start/success/retry structured-log receivers (#1917). Side-effect
        # import: the @receiver decorators in receivers.py connect on load.
        from trueppm_api.apps.observability.otel.metrics import record_task_duration
        from trueppm_api.apps.scheduling import receivers  # noqa: F401
        from trueppm_api.apps.scheduling.signals import (
            celery_task_failed,
            celery_task_retried,
            celery_task_started,
            celery_task_succeeded,
        )

        self._register_workflows()

        @task_prerun.connect(weak=False, dispatch_uid="scheduling.on_task_prerun")  # type: ignore[untyped-decorator]
        def _on_task_prerun(sender: Any, task_id: str, task: Any, **kwargs: Any) -> None:
            _task_start_times[task_id] = time.monotonic()
            celery_task_started.send(
                sender=type(task).__name__,
                task_id=task_id,
                task_name=getattr(task, "name", ""),
                args=kwargs.get("args", ()),
                kwargs=kwargs.get("kwargs", {}),
            )

        @task_postrun.connect(weak=False, dispatch_uid="scheduling.on_task_postrun")  # type: ignore[untyped-decorator]
        def _on_task_postrun(
            sender: Any, task_id: str, task: Any, retval: Any, **kwargs: Any
        ) -> None:
            # task_postrun fires for every terminal state (success, failure, retry,
            # rejected, ignored) — unlike celery_task_succeeded below, the duration
            # metric is recorded for all of them so a stuck/slow retry loop is
            # visible in the histogram too, not just clean runs.
            state = kwargs.get("state", "") or ""
            task_name = getattr(task, "name", "")
            start = _task_start_times.pop(task_id, None)
            duration = time.monotonic() - start if start is not None else 0.0
            record_task_duration(
                task_name=task_name,
                duration_seconds=duration,
                outcome=state.lower() or "unknown",
            )
            if state == "SUCCESS":
                celery_task_succeeded.send(
                    sender=type(task).__name__,
                    task_id=task_id,
                    task_name=task_name,
                    runtime_seconds=duration,
                )

        @task_failure.connect(weak=False, dispatch_uid="scheduling.on_task_failure")  # type: ignore[untyped-decorator]
        def _on_task_failure(
            sender: Any, task_id: str, exception: BaseException, **kwargs: Any
        ) -> None:
            import traceback as tb_module

            celery_task_failed.send(
                sender=type(sender).__name__,
                task_id=task_id,
                task_name=getattr(sender, "name", ""),
                exception=exception,
                traceback_str="".join(
                    tb_module.format_exception(type(exception), exception, exception.__traceback__)
                ),
            )

        @task_retry.connect(weak=False, dispatch_uid="scheduling.on_task_retry")  # type: ignore[untyped-decorator]
        def _on_task_retry(sender: Any, request: Any, reason: Any, **kwargs: Any) -> None:
            celery_task_retried.send(
                sender=type(sender).__name__,
                task_id=getattr(request, "id", ""),
                task_name=getattr(sender, "name", ""),
                attempt=getattr(request, "retries", 0),
                exception=reason,
            )

    @staticmethod
    def _register_workflows() -> None:
        """Register the scheduling app's durable workflow definitions (ADR-0080 §A).

        The requeue-failed-task workflow (ADR-0210) is the first consumer of the
        durable backend. Registered here from the owning app's ``ready()`` — the
        scheduling app owns ``FailedTask`` and already bridges Celery signals in
        ``ready()``, so the workflow lives with its domain rather than in the
        backend-neutral engine app. Guarded against duplicate registration because
        ``ready()`` can run more than once under the test runner and the registry
        raises on a duplicate name.
        """
        from trueppm_api.workflows.consumers.requeue_failed_task import (
            RequeueFailedTaskWorkflow,
        )
        from trueppm_api.workflows.registry import WORKFLOWS

        if RequeueFailedTaskWorkflow.name not in WORKFLOWS.all():
            WORKFLOWS.register(RequeueFailedTaskWorkflow())
