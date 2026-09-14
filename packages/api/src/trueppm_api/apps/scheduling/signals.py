"""Task lifecycle Django signals.

Enterprise extension point: connect receivers for PagerDuty, Slack, or
custom alerting without modifying OSS code.

These are bridged from Celery's framework signals in SchedulingConfig.ready().

**Every signal in this module is dispatched with ``sender=None``** — they are
about a worker run, not a model row, so there is no class for Django's
dispatcher to filter on, and the terminal one is sent from the dead-letter
recorder, which has only the task's name (#3777). Connect a receiver with no
sender filter and branch on the ``task_name`` kwarg, which every payload here
carries::

    @receiver(celery_task_failed)
    def alert(sender, task_name="", **kwargs):
        if task_name == "trueppm_api.apps.scheduling.tasks.recalculate_schedule":
            ...

A receiver registered as ``@receiver(celery_task_started, sender=SomeClass)``
will never fire. See ``core/extension_signals.py`` for the project-wide sender
and kwarg conventions.
"""

from __future__ import annotations

import django.dispatch

# Sent when a Celery task begins execution.
# sender: None. kwargs: task_id, task_name, args, kwargs
celery_task_started = django.dispatch.Signal()

# Sent when a Celery task completes successfully.
# sender: None. kwargs: task_id, task_name, runtime_seconds
celery_task_succeeded = django.dispatch.Signal()

# Sent when a Celery task fails (before retry or on final failure).
# sender: None. kwargs: task_id, task_name, exception, traceback_str
celery_task_failed = django.dispatch.Signal()

# Sent when a Celery task is about to be retried.
# sender: None. kwargs: task_id, task_name, attempt, exception
celery_task_retried = django.dispatch.Signal()

# Sent when a Celery task is permanently dead-lettered (retries exhausted and a
# FailedTask row was newly created). Distinct from celery_task_failed, which
# fires on every failure including those that will be retried — this fires once,
# only on the terminal transition. sender: None. kwargs: task_id, task_name,
# exception, traceback_str, project_id (None when the failing task carries no
# project).
#
# Enterprise registers an additional receiver here for PagerDuty/Slack alerting
# (ADR-0084) in its own AppConfig.ready(); the OSS default receiver lives in
# scheduling/receivers.py and only logs. Fired via send_robust so no receiver
# can break the dead-letter recording path.
celery_task_permanently_failed = django.dispatch.Signal()
