"""App config for access (RBAC)."""

from __future__ import annotations

from django.apps import AppConfig


class AccessConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.access"
