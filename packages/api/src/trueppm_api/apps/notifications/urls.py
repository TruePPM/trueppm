"""URL routing for /api/v1/me/notifications/ and /api/v1/me/notification-preferences/."""

from __future__ import annotations

from django.urls import path

from .views import NotificationPreferenceViewSet, NotificationViewSet

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
    path(
        "me/notification-preferences/<int:pk>/",
        NotificationPreferenceViewSet.as_view({"patch": "partial_update"}),
        name="me-notification-preferences-detail",
    ),
]
