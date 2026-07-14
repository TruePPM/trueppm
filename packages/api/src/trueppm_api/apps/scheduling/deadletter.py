"""Dead-letter helper — records permanently failed Celery tasks."""

from __future__ import annotations

import logging
import traceback as tb_module

logger = logging.getLogger(__name__)


def record_failed_task(
    task_name: str,
    task_id: str,
    args: list[object] | tuple[object, ...],
    kwargs: dict[str, object],
    exception: BaseException,
    project_id: str | None = None,
) -> None:
    """Write a FailedTask row for a permanently failed Celery task.

    Called from the on_failure handler when max_retries is exhausted.
    Safe to call from within a Celery worker — uses its own DB connection.

    On the *terminal* transition (a FailedTask row is newly created) this fires
    ``celery_task_permanently_failed`` so OSS logs an alert and Enterprise can
    register PagerDuty/Slack receivers (ADR-0084). A repeat dead-letter of the
    same ``task_id`` only bumps ``failure_count`` and does **not** re-alert, so
    the signal means "newly dead-lettered", not "failed again". ``project_id``
    is threaded through from the caller when known (it is not derivable here).
    """
    from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus
    from trueppm_api.apps.scheduling.signals import celery_task_permanently_failed

    exc_type = type(exception).__qualname__
    exc_msg = str(exception)
    exc_tb = "".join(
        tb_module.format_exception(type(exception), exception, exception.__traceback__)
    )

    defaults: dict[str, object] = {
        "task_name": task_name,
        "args": list(args) if args else [],
        "kwargs": dict(kwargs) if kwargs else {},
        "exception_type": exc_type,
        "exception_message": exc_msg,
        "traceback": exc_tb,
        "status": FailedTaskStatus.DEAD,
    }
    # Only set project_id when this call actually knows it (#1917).
    # update_or_create's defaults overwrite unconditionally, so unconditionally
    # including a bare `None` here would erase a project attribution recorded by
    # an earlier failure of the same task_id the moment a later re-failure's
    # call site didn't have project_id in scope.
    if project_id is not None:
        defaults["project_id"] = project_id

    obj, created = FailedTask.objects.update_or_create(
        task_id=task_id,
        defaults=defaults,
    )
    if not created:
        FailedTask.objects.filter(pk=obj.pk).update(
            failure_count=obj.failure_count + 1,
        )

    logger.error(
        "Dead-lettered task %s (%s): %s: %s",
        task_name,
        task_id,
        exc_type,
        exc_msg,
    )

    if created:
        # send_robust: a misbehaving receiver (incl. enterprise PagerDuty/Slack)
        # must never break the dead-letter recording path.
        celery_task_permanently_failed.send_robust(
            sender=task_name,
            task_id=task_id,
            task_name=task_name,
            exception=exception,
            traceback_str=exc_tb,
            project_id=project_id,
        )
