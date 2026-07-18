"""Response-conformance regression tests for the Task endpoints (#2127).

Schemathesis flagged that ``PATCH /api/v1/tasks/{id}/`` dropped
``baseline_start`` / ``baseline_finish`` from the response whenever the
re-serialized task carried no active-baseline annotation. The cause was DRF's
partial-update behaviour: a read-only field declared with ``default=None`` has
``get_default()`` raise ``SkipField`` when ``partial`` is set, dropping the key
entirely — so the response omitted a schema-required field. Removing the
redundant ``default`` (``allow_null=True`` already covers the missing-attribute
case) keeps the key present as ``null`` on every path.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def user() -> object:
    return User.objects.create_user(username="pat", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project() -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Foundation", duration=3)


def test_patch_keeps_baseline_fields_as_null_when_no_baseline(
    client: APIClient, membership: ProjectMembership, task: Task
) -> None:
    """A partial update must still emit baseline_* as null, not drop the keys (#2127).

    Without an active baseline the annotation is absent; the fields must serialize
    as ``null`` rather than being omitted (which failed schema conformance).
    """
    r = client.patch(f"/api/v1/tasks/{task.pk}/", {"name": "Foundation v2"}, format="json")
    assert r.status_code == 200
    assert "baseline_start" in r.data, "baseline_start must be present on a partial update."
    assert "baseline_finish" in r.data, "baseline_finish must be present on a partial update."
    assert r.data["baseline_start"] is None
    assert r.data["baseline_finish"] is None


def test_get_still_emits_baseline_fields_as_null(
    client: APIClient, membership: ProjectMembership, task: Task
) -> None:
    """The read path is unchanged: baseline_* present and null with no baseline (#2127)."""
    r = client.get(f"/api/v1/tasks/{task.pk}/")
    assert r.status_code == 200
    assert r.data["baseline_start"] is None
    assert r.data["baseline_finish"] is None
