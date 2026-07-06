"""URL routing for ``/api/v1/me/credentials/`` (ADR-0049 §3, #587),
``/api/v1/me/connections/`` (ADR-0097 §3, #1418), and the per-project Git-event
board automation (#329, ADR-0158)."""

from __future__ import annotations

from django.urls import path

from .connections import (
    ExternalConnectionSyncView,
    ExternalConnectionView,
    ExternalWorkItemListView,
)
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
    # User-scoped external task source connections (ADR-0097 §3, #1418). The
    # source key is a distinct EXTERNAL_TASK_SOURCES key (e.g. ``jira``); the
    # view re-validates it against the registry, so a typo returns a clean 400.
    path(
        "me/connections/<slug:source>/",
        ExternalConnectionView.as_view(),
        name="me-connections-detail",
    ),
    # Trigger a read-only pull of the connection (ADR-0097 §4, #1419). Returns
    # 202 {"queued": true}; the pull runs through the ExternalSyncRequest outbox.
    path(
        "me/connections/<slug:source>/sync/",
        ExternalConnectionSyncView.as_view(),
        name="me-connections-sync",
    ),
    # The user's cached external work items, for the My Work external section
    # (ADR-0097 §3). Strictly personal — filtered to request.user.
    path(
        "me/external-items/",
        ExternalWorkItemListView.as_view(),
        name="me-external-items-list",
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
