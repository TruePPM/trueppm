"""OSS signal receivers for the scheduling app.

The default dead-letter alerting receiver (ADR-0084). When a Celery task is
permanently dead-lettered, OSS emits a single structured WARNING line that an
operator (or a log-based metrics aggregator) can alert on. Enterprise registers
*additional* receivers on the same signal for PagerDuty/Slack in its own
AppConfig.ready() — this module is never imported by enterprise and imports
nothing from it.

Also holds the start/success/retry structured-log receivers (#1917) that
complement the dead-letter alert above — each Celery task's full lifecycle
(started → succeeded, or started → retried → ... → dead-lettered) is now a
structured, greppable/aggregatable log line rather than the ad-hoc
``logger.info`` calls scattered across individual task bodies.

Wired by SchedulingConfig.ready() via ``from . import receivers``.
"""

from __future__ import annotations

import logging
from typing import Any

from django.dispatch import receiver

from trueppm_api.apps.scheduling.signals import (
    celery_task_permanently_failed,
    celery_task_retried,
    celery_task_started,
    celery_task_succeeded,
)

logger = logging.getLogger(__name__)


@receiver(celery_task_permanently_failed)
def log_dead_letter_alert(
    sender: Any,
    task_id: str = "",
    task_name: str = "",
    exception: BaseException | None = None,
    project_id: str | None = None,
    **_kwargs: Any,
) -> None:
    """Emit a WARNING alert line for a newly dead-lettered task.

    Distinct from the ERROR line in ``record_failed_task`` (which records the
    raw failure): this is the *alert*, carrying structured ``extra`` fields so
    log pipelines can build the ``trueppm_task_dead_letter_count`` series by
    ``task_name`` without parsing the message. Broad ``except`` because an
    alerting failure must never propagate back into the dead-letter path — the
    signal is dispatched with ``send_robust`` for the same reason, so this is
    belt-and-braces against a logging-config error masking a task failure.
    """
    try:
        logger.warning(
            "dead-letter alert: task %s (%s) permanently failed: %s",
            task_name,
            task_id,
            type(exception).__qualname__ if exception is not None else "unknown",
            extra={
                "task_name": task_name,
                "task_id": task_id,
                "exception_type": (
                    type(exception).__qualname__ if exception is not None else "unknown"
                ),
                "project_id": project_id,
            },
        )
    except Exception:
        logger.exception("dead-letter alert receiver failed")


@receiver(celery_task_started)
def log_task_started(
    sender: Any,
    task_id: str = "",
    task_name: str = "",
    **_kwargs: Any,
) -> None:
    """Emit a structured INFO line when a Celery task begins execution (#1917).

    Bridged from the ``task_prerun`` framework signal in
    ``SchedulingConfig.ready()`` for every task in the process. Broad ``except``
    (matching ``log_dead_letter_alert``): this is bridged via a plain (not
    ``send_robust``) Django signal fired synchronously inside the worker's task
    execution path, so a logging-config error here must never surface as (or
    interrupt) a task failure.
    """
    try:
        logger.info(
            "task started: %s (%s)",
            task_name,
            task_id,
            extra={"task_name": task_name, "task_id": task_id, "outcome": "started"},
        )
    except Exception:
        logger.exception("task-started log receiver failed")


@receiver(celery_task_succeeded)
def log_task_succeeded(
    sender: Any,
    task_id: str = "",
    task_name: str = "",
    runtime_seconds: float = 0.0,
    **_kwargs: Any,
) -> None:
    """Emit a structured INFO line when a Celery task completes successfully (#1917)."""
    try:
        logger.info(
            "task succeeded: %s (%s) in %.3fs",
            task_name,
            task_id,
            runtime_seconds,
            extra={
                "task_name": task_name,
                "task_id": task_id,
                "outcome": "succeeded",
                "runtime_seconds": runtime_seconds,
            },
        )
    except Exception:
        logger.exception("task-succeeded log receiver failed")


@receiver(celery_task_retried)
def log_task_retried(
    sender: Any,
    task_id: str = "",
    task_name: str = "",
    attempt: int = 0,
    exception: BaseException | None = None,
    **_kwargs: Any,
) -> None:
    """Emit a structured WARNING line when a Celery task is about to be retried (#1917).

    Distinct from ``log_dead_letter_alert``: this fires on *every* retry attempt
    (the task will run again), the dead-letter alert fires once, only on the
    terminal transition after retries are exhausted.
    """
    try:
        logger.warning(
            "task retry: %s (%s) attempt %s: %s",
            task_name,
            task_id,
            attempt,
            exception,
            extra={
                "task_name": task_name,
                "task_id": task_id,
                "outcome": "retried",
                "attempt": attempt,
                "exception_type": (
                    type(exception).__qualname__ if exception is not None else "unknown"
                ),
            },
        )
    except Exception:
        logger.exception("task-retried log receiver failed")
