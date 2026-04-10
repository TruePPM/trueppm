"""Task lifecycle Django signals.

Enterprise extension point: connect receivers for PagerDuty, Slack, or
custom alerting without modifying OSS code.

These are bridged from Celery's framework signals in SchedulingConfig.ready().
"""

from __future__ import annotations

import django.dispatch

# Sent when a Celery task begins execution.
# kwargs: task_id, task_name, args, kwargs
celery_task_started = django.dispatch.Signal()

# Sent when a Celery task completes successfully.
# kwargs: task_id, task_name, runtime_seconds
celery_task_succeeded = django.dispatch.Signal()

# Sent when a Celery task fails (before retry or on final failure).
# kwargs: task_id, task_name, exception, traceback_str
celery_task_failed = django.dispatch.Signal()

# Sent when a Celery task is about to be retried.
# kwargs: task_id, task_name, attempt, exception
celery_task_retried = django.dispatch.Signal()
