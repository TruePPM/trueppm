"""URL routing for MS Project import/export."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.msproject.views import (
    MsProjectExportView,
    MsProjectImportView,
)

urlpatterns = [
    path(
        "projects/<project_pk>/import/msproject/",
        MsProjectImportView.as_view(),
        name="project-import-msproject",
    ),
    path(
        "projects/<project_pk>/export/msproject.xml",
        MsProjectExportView.as_view(),
        name="project-export-msproject",
    ),
]
