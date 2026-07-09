"""URL routing for /api/v1/me/notifications/ and /api/v1/me/notification-preferences/."""

from __future__ import annotations

from django.urls import path

from .views import (
    MyNotificationSettingsView,
    NotificationPreferenceViewSet,
    NotificationViewSet,
    ProjectNotificationPreferenceView,
    WorkspaceEmailHealthView,
    WorkspaceEmailSettingsView,
    WorkspaceEmailTestView,
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
    # Per-notification snooze / un-snooze (ADR-0216 §1). Explicit path because
    # this app wires the viewset with as_view() rather than a router, so @action
    # isn't auto-routed.
    path(
        "me/notifications/<uuid:pk>/snooze/",
        NotificationViewSet.as_view({"post": "snooze"}),
        name="me-notifications-snooze",
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
    # Account-wide notification settings — Do-Not-Disturb switch (#1707, ADR-0292)
    path(
        "me/notification-settings/",
        MyNotificationSettingsView.as_view(),
        name="me-notification-settings",
    ),
    # Project-scoped routing matrix + quiet hours (#522)
    path(
        "projects/<uuid:pk>/notification-preferences/",
        ProjectNotificationPreferenceView.as_view(),
        name="project-notification-preferences",
    ),
    # Workspace Email & SMTP — writable transport config (#712, ADR-0213),
    # upgrading the #639 read-only status surface at the same path.
    path(
        "workspace/email-settings/",
        WorkspaceEmailSettingsView.as_view(),
        name="workspace-email-settings",
    ),
    path(
        "workspace/email-settings/send-test/",
        WorkspaceEmailTestView.as_view(),
        name="workspace-email-settings-send-test",
    ),
    path(
        "workspace/email-settings/health/",
        WorkspaceEmailHealthView.as_view(),
        name="workspace-email-settings-health",
    ),
]
