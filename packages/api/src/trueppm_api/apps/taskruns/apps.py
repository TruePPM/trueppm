"""AppConfig for the taskruns app — long-running task progress tracking."""

from __future__ import annotations

from django.apps import AppConfig


class TaskRunsConfig(AppConfig):
    name = "trueppm_api.apps.taskruns"
    default_auto_field = "django.db.models.BigAutoField"
