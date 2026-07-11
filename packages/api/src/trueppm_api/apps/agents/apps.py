"""AppConfig for the agents app — OSS agent-as-actor audit substrate (ADR-0112)."""

from __future__ import annotations

from django.apps import AppConfig


class AgentsConfig(AppConfig):
    name = "trueppm_api.apps.agents"
    verbose_name = "Agents"
    default_auto_field = "django.db.models.BigAutoField"
