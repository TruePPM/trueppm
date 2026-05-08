"""Service-layer helpers for the resources app."""

from __future__ import annotations

from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.resources.models import ProjectResource, Resource


def ensure_project_resource(project: Project, resource: Resource) -> ProjectResource:
    """Idempotently add a resource to a project's roster.

    Centralises the auto-roster pattern: any code path that creates a
    task–resource assignment (TaskResource) must call this so the resource
    appears in Team → Roster, Allocation, and Heatmap views (#241).

    Returns the existing ``ProjectResource`` row when one is already present
    (whether live or soft-deleted), otherwise creates a new live row. Soft-
    deleted rows are intentionally left alone — the soft-delete is a deliberate
    PM action and reactivation belongs to the explicit roster UI, not to the
    side-effect of a task assignment.
    """
    obj, _ = ProjectResource.objects.get_or_create(
        project=project,
        resource=resource,
    )
    return obj
