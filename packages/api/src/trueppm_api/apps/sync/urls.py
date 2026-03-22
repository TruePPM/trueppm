"""URL patterns for the sync app."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.sync.views import ProjectSyncView

urlpatterns = [
    path("projects/<uuid:pk>/sync/", ProjectSyncView.as_view(), name="project-sync"),
]
