"""URL routing for CSV / Excel import."""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.csvimport.views import (
    CsvImportPreviewView,
    CsvImportStatusView,
    CsvImportTemplateView,
    CsvImportUndoView,
    CsvImportView,
)

urlpatterns = [
    # Declared before the <project_pk> routes and mounted ahead of the projects
    # router so the literal "import-templates" segment is never captured as a
    # project primary key.
    path(
        "import-templates/csv/",
        CsvImportTemplateView.as_view(),
        name="csv-import-template",
    ),
    # Preview before import: declared first so "preview" is not swallowed by the
    # commit route.
    path(
        "projects/<project_pk>/import/csv/preview/",
        CsvImportPreviewView.as_view(),
        name="project-import-csv-preview",
    ),
    path(
        "projects/<project_pk>/import/csv/",
        CsvImportView.as_view(),
        name="project-import-csv",
    ),
    path(
        "projects/<project_pk>/import/csv/<pk>/",
        CsvImportStatusView.as_view(),
        name="project-import-csv-status",
    ),
    # Declared after the status route: "undo" would otherwise never be reached
    # if a router matched it as a <pk> segment first, though plain path()
    # entries don't have that ambiguity — kept last anyway for readability,
    # status then action, mirroring the rest of this file's ordering.
    path(
        "projects/<project_pk>/import/csv/<pk>/undo/",
        CsvImportUndoView.as_view(),
        name="project-import-csv-undo",
    ),
]
