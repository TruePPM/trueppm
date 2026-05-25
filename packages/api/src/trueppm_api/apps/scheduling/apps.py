"""App config for scheduling."""

from __future__ import annotations

import logging
from typing import Any

from django.apps import AppConfig

logger = logging.getLogger(__name__)


class SchedulingConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.scheduling"

    def ready(self) -> None:
        """Bridge Celery framework signals to Django signals.

        Enterprise packages connect receivers to the Django signals in
        scheduling.signals — they never need to import from Celery directly.
        """
        from celery.signals import task_failure, task_postrun, task_prerun, task_retry

        # Register the OSS dead-letter alerting receiver (ADR-0084). Side-effect
        # import: the @receiver decorator in receivers.py connects on load.
        from trueppm_api.apps.scheduling import receivers  # noqa: F401
        from trueppm_api.apps.scheduling.signals import (
            celery_task_failed,
            celery_task_retried,
            celery_task_started,
            celery_task_succeeded,
        )

        @task_prerun.connect  # type: ignore[untyped-decorator]
        def _on_task_prerun(sender: Any, task_id: str, task: Any, **kwargs: Any) -> None:
            celery_task_started.send(
                sender=type(task).__name__,
                task_id=task_id,
                task_name=getattr(task, "name", ""),
                args=kwargs.get("args", ()),
                kwargs=kwargs.get("kwargs", {}),
            )

        @task_postrun.connect  # type: ignore[untyped-decorator]
        def _on_task_postrun(
            sender: Any, task_id: str, task: Any, retval: Any, **kwargs: Any
        ) -> None:
            # task_postrun fires on success and failure; only emit succeeded on success
            state = kwargs.get("state", "")
            if state == "SUCCESS":
                celery_task_succeeded.send(
                    sender=type(task).__name__,
                    task_id=task_id,
                    task_name=getattr(task, "name", ""),
                    runtime_seconds=getattr(task.request, "runtime", 0) or 0,
                )

        @task_failure.connect  # type: ignore[untyped-decorator]
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

        @task_retry.connect  # type: ignore[untyped-decorator]
        def _on_task_retry(sender: Any, request: Any, reason: Any, **kwargs: Any) -> None:
            celery_task_retried.send(
                sender=type(sender).__name__,
                task_id=getattr(request, "id", ""),
                task_name=getattr(sender, "name", ""),
                attempt=getattr(request, "retries", 0),
                exception=reason,
            )
