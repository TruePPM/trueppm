"""Celery application instance."""

from __future__ import annotations

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "trueppm_api.settings.dev")

app = Celery("trueppm_api")

# Read configuration from Django settings under the CELERY_ namespace.
app.config_from_object("django.conf:settings", namespace="CELERY")

# Auto-discover tasks in all installed apps.
app.autodiscover_tasks()

# Side-effect-only imports: each module connects Celery signal handlers at
# import time, and none of its names are used here.
#
# worker_broker_wait — a worker_init handler that holds worker start until the
# broker answers a PING, so the consumer never boots into kombu's reconnect path
# (#3722).
#
# worker_heartbeat — the worker_ready/heartbeat_sent/worker_shutting_down
# handlers that back the Helm chart's worker startup/readiness probes (#3346).
#
# Both are harmless to import in the `beat` process: beat runs no worker
# consumer, so none of these signals fire there.
from trueppm_api.core import worker_broker_wait, worker_heartbeat  # noqa: E402,F401
