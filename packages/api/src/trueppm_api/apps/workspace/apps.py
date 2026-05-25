"""App config for the workspace app (org-level config, membership, groups — ADR-0087)."""

from __future__ import annotations

from django.apps import AppConfig


class WorkspaceConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.workspace"
