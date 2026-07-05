"""URL patterns for the sync app."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.sync.views import (
    ProjectSyncView,
    UserProgramSyncView,
    WebSocketTicketView,
)

urlpatterns = [
    path("projects/<uuid:pk>/sync/", ProjectSyncView.as_view(), name="project-sync"),
    path("sync/user/programs/", UserProgramSyncView.as_view(), name="user-program-sync"),
    path("ws/ticket/", WebSocketTicketView.as_view(), name="ws-ticket"),
]
