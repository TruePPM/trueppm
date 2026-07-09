"""Cross-project relocation guards on writable relation FKs (#1711, BOLA).

Each of ``Task.project``, ``TaskResource.task`` and ``ProjectResource.project`` is
writable on the serializer. Object-level permission checks only validate the
object's *current* parent, so without a serializer-level guard a member of
project A could PATCH the FK to relocate the row into a project B they cannot
see. These tests assert the relocation is rejected and the FK is left unchanged.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project_a(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def project_b(calendar: Calendar) -> Project:
    """A project the acting user is NOT a member of."""
    return Project.objects.create(name="Bravo", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def actor(project_a: Project) -> object:
    """OWNER of project A only — cannot see project B."""
    user = User.objects.create_user(username="fk_actor", password="pw")
    ProjectMembership.objects.create(project=project_a, user=user, role=Role.OWNER)
    return user


@pytest.fixture
def client(actor: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=actor)
    return c


@pytest.fixture
def resource(db: object) -> Resource:
    return Resource.objects.create(name="Alice", email="alice@x.io", max_units=Decimal("1.0"))


@pytest.mark.django_db
def test_task_project_cannot_be_relocated(
    client: APIClient, project_a: Project, project_b: Project
) -> None:
    task = Task.objects.create(project=project_a, name="Design", duration=5)
    resp = client.patch(f"/api/v1/tasks/{task.pk}/", {"project": str(project_b.pk)}, format="json")
    assert resp.status_code == 400
    task.refresh_from_db()
    assert task.project_id == project_a.pk


@pytest.mark.django_db
def test_task_resource_task_cannot_be_relocated(
    client: APIClient, project_a: Project, project_b: Project, resource: Resource
) -> None:
    task_a = Task.objects.create(project=project_a, name="A", duration=1)
    task_b = Task.objects.create(project=project_b, name="B", duration=1)
    tr = TaskResource.objects.create(task=task_a, resource=resource, units=Decimal("1.0"))
    resp = client.patch(f"/api/v1/task-resources/{tr.pk}/", {"task": str(task_b.pk)}, format="json")
    assert resp.status_code == 400
    tr.refresh_from_db()
    assert tr.task_id == task_a.pk


@pytest.mark.django_db
def test_project_resource_project_cannot_be_relocated(
    client: APIClient, project_a: Project, project_b: Project, resource: Resource
) -> None:
    pr = ProjectResource.objects.create(project=project_a, resource=resource)
    resp = client.patch(
        f"/api/v1/project-resources/{pr.pk}/", {"project": str(project_b.pk)}, format="json"
    )
    assert resp.status_code == 400
    pr.refresh_from_db()
    assert pr.project_id == project_a.pk
