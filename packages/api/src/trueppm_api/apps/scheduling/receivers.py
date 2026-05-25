"""OSS signal receivers for the scheduling app.

The default dead-letter alerting receiver (ADR-0084). When a Celery task is
permanently dead-lettered, OSS emits a single structured WARNING line that an
operator (or a log-based metrics aggregator) can alert on. Enterprise registers
*additional* receivers on the same signal for PagerDuty/Slack in its own
AppConfig.ready() — this module is never imported by enterprise and imports
nothing from it.

Wired by SchedulingConfig.ready() via ``from . import receivers``.
"""

from __future__ import annotations

import logging
from typing import Any

from django.dispatch import receiver

from trueppm_api.apps.scheduling.signals import celery_task_permanently_failed

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
