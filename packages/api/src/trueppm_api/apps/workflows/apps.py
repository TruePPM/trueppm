"""App config for the workflow execution engine (ADR-0080).

Holds the persistence layer (models, migrations, beat drain) for the default
workflow backend. The public import surface workflow authors target lives at
``trueppm_api.workflows`` (interface, services, backends, consumers); this app
is a backend implementation detail those consumers never import directly, which
is what preserves backend-neutrality (ADR-0080 §E).
"""

from __future__ import annotations

from django.apps import AppConfig


class WorkflowsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.workflows"
