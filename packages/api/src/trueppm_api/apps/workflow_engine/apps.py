"""App config for the workflow execution engine (ADR-0080).

Holds the persistence layer (models, migrations, beat drain) for the default
workflow backend. The public import surface workflow authors target lives at
``trueppm_api.workflows`` (interface, services, backends, registry); this app
is a backend implementation detail those consumers never import directly, which
is what preserves backend-neutrality (ADR-0080 §E).

Named ``workflow_engine`` (not ``workflows``) so the app label does not collide
with the ``trueppm_api.workflows`` public package — that collision confused tools
that map app label → module (the mypy django-stubs plugin stopped recognizing
these as models), and is avoided by naming the engine's persistence app and the
public API package distinctly.
"""

from __future__ import annotations

from django.apps import AppConfig


class WorkflowEngineConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.workflow_engine"
