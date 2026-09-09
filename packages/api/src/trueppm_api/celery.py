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

# Registers the worker_ready/heartbeat_sent/worker_shutting_down signal handlers
# that back the Helm chart's worker startup/readiness probes (#3346). Import
# for its side effect only: the module connects Celery signal handlers at
# import time and none of its names are used here. Harmless to import in the
# `beat` process too — beat runs no worker consumer, so worker_ready and
# heartbeat_sent never fire there.
from trueppm_api.core import worker_heartbeat  # noqa: E402,F401
