"""URL routing for MS Project import/export."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.msproject.views import (
    CreateProjectFromMsProjectView,
    MsProjectExportView,
    MsProjectImportView,
)

urlpatterns = [
    # Create-from-import (ADR-0092). Declared before the <project_pk> route and
    # mounted ahead of the projects router so the literal "import" segment is not
    # captured as a project primary key.
    path(
        "projects/import/msproject/",
        CreateProjectFromMsProjectView.as_view(),
        name="project-create-from-msproject",
    ),
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
