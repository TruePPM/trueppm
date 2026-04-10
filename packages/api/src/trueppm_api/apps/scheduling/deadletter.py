"""Dead-letter helper — records permanently failed Celery tasks."""

from __future__ import annotations

import logging
import traceback as tb_module

logger = logging.getLogger(__name__)


def record_failed_task(
    task_name: str,
    task_id: str,
    args: list | tuple,
    kwargs: dict,
    exception: BaseException,
) -> None:
    """Write a FailedTask row for a permanently failed Celery task.

    Called from the on_failure handler when max_retries is exhausted.
    Safe to call from within a Celery worker — uses its own DB connection.
    """
    from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus

    exc_type = type(exception).__qualname__
    exc_msg = str(exception)
    exc_tb = "".join(tb_module.format_exception(type(exception), exception, exception.__traceback__))

    obj, created = FailedTask.objects.update_or_create(
        task_id=task_id,
        defaults={
            "task_name": task_name,
            "args": list(args) if args else [],
            "kwargs": dict(kwargs) if kwargs else {},
            "exception_type": exc_type,
            "exception_message": exc_msg,
            "traceback": exc_tb,
            "status": FailedTaskStatus.DEAD,
        },
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
