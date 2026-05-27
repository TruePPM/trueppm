"""Permission tests for ProjectViewSet update/partial_update (#769).

Editing project-level settings is a Project Manager (Admin) concern. Before the
fix, update/partial_update fell through to ``IsProjectMember``, which passes for
Viewer (role 0) and Member — a read-only role could rename or recolor a project.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="PermProj", start_date=date(2026, 3, 1), calendar=calendar)


def _client_for(project: Project, role: int, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER])
def test_update_project_denied_below_admin(project: Project, role: int) -> None:
    client = _client_for(project, role, f"u_{int(role)}")
    resp = client.patch(f"/api/v1/projects/{project.pk}/", {"name": "Renamed"}, format="json")
    assert resp.status_code == 403
    project.refresh_from_db()
    assert project.name == "PermProj"


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.ADMIN, Role.OWNER])
def test_update_project_allowed_admin_and_owner(project: Project, role: int) -> None:
    client = _client_for(project, role, f"u_{int(role)}")
    resp = client.patch(f"/api/v1/projects/{project.pk}/", {"name": "Renamed"}, format="json")
    assert resp.status_code == 200
    project.refresh_from_db()
    assert project.name == "Renamed"
