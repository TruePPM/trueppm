"""URL routing for ``/api/v1/me/credentials/`` (ADR-0049 §3, #587) and the
per-project Git-event board automation (#329, ADR-0158)."""

from __future__ import annotations

from django.urls import path

from .views import (
    GitAutomationConfigView,
    GitAutomationRotateSecretView,
    GitWebhookIngestView,
    IntegrationCredentialViewSet,
)

# Provider key is captured as ``<slug:provider>`` — TASK_LINK_PROVIDERS keys
# are short ascii (gitlab, github, generic, jira, servicenow…), so the slug
# converter is the right shape. The viewset re-validates the key against
# the registry, so a typo'd provider returns a clean 400 rather than 404.
urlpatterns = [
    path(
        "me/credentials/",
        IntegrationCredentialViewSet.as_view({"get": "list"}),
        name="me-credentials-list",
    ),
    path(
        "me/credentials/<slug:provider>/",
        IntegrationCredentialViewSet.as_view(
            {"get": "retrieve", "post": "create", "delete": "destroy"}
        ),
        name="me-credentials-detail",
    ),
    # Git-event board automation (#329, ADR-0158). The kwarg MUST be ``project_pk``
    # so ``IsProjectAdmin`` can resolve project membership on the config routes.
    path(
        "integrations/projects/<uuid:project_pk>/git-webhook/",
        GitWebhookIngestView.as_view(),
        name="git-webhook",
    ),
    path(
        "integrations/projects/<uuid:project_pk>/git-automation/",
        GitAutomationConfigView.as_view(),
        name="git-automation-config",
    ),
    path(
        "integrations/projects/<uuid:project_pk>/git-automation/rotate-secret/",
        GitAutomationRotateSecretView.as_view(),
        name="git-automation-rotate-secret",
    ),
]
