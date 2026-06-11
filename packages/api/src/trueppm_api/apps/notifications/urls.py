"""URL routing for /api/v1/me/notifications/ and /api/v1/me/notification-preferences/."""

from __future__ import annotations

from django.urls import path

from .views import (
    EmailSettingsStatusView,
    NotificationPreferenceViewSet,
    NotificationViewSet,
    ProjectNotificationPreferenceView,
)

urlpatterns = [
    # Notification inbox
    path(
        "me/notifications/",
        NotificationViewSet.as_view({"get": "list"}),
        name="me-notifications-list",
    ),
    path(
        "me/notifications/<uuid:pk>/",
        NotificationViewSet.as_view({"get": "retrieve", "patch": "partial_update"}),
        name="me-notifications-detail",
    ),
    path(
        "me/notifications/mark-all-read/",
        NotificationViewSet.as_view({"post": "mark_all_read"}),
        name="me-notifications-mark-all-read",
    ),
    # Notification preference matrix
    path(
        "me/notification-preferences/",
        NotificationPreferenceViewSet.as_view({"get": "list"}),
        name="me-notification-preferences-list",
    ),
    # Signal-only / everything preset (#855). Explicit path because this app wires
    # the viewset with as_view() rather than a router, so @action isn't auto-routed.
    path(
        "me/notification-preferences/apply-preset/",
        NotificationPreferenceViewSet.as_view({"post": "apply_preset"}),
        name="me-notification-preferences-apply-preset",
    ),
    path(
        "me/notification-preferences/<int:pk>/",
        NotificationPreferenceViewSet.as_view({"patch": "partial_update"}),
        name="me-notification-preferences-detail",
    ),
    # Project-scoped routing matrix + quiet hours (#522)
    path(
        "projects/<uuid:pk>/notification-preferences/",
        ProjectNotificationPreferenceView.as_view(),
        name="project-notification-preferences",
    ),
    # Workspace Email & SMTP status — read-only (#639, ADR-0085 §5)
    path(
        "workspace/email-settings/",
        EmailSettingsStatusView.as_view(),
        name="workspace-email-settings",
    ),
]
