"""Tests for the project delta sync pull endpoint."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="sync_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="SyncProj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)


@pytest.fixture
def authed_client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/sync/"


# ---------------------------------------------------------------------------
# Auth / permission
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_requires_auth(project: Project, membership: ProjectMembership) -> None:
    resp = APIClient().get(_url(project))
    assert resp.status_code == 401


@pytest.mark.django_db
def test_sync_requires_membership(project: Project) -> None:
    outsider = User.objects.create_user(username="out", password="pw")
    c = APIClient()
    c.force_authenticate(user=outsider)
    resp = c.get(_url(project))
    assert resp.status_code == 403


@pytest.mark.django_db
def test_sync_404_for_missing_project(authed_client: APIClient) -> None:
    import uuid

    resp = authed_client.get(f"/api/v1/projects/{uuid.uuid4()}/sync/")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Response structure
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_response_shape(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_snapshot_max_version",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert resp.status_code == 200
    assert "changes" in resp.data
    assert "timestamp" in resp.data
    for key in ("projects", "tasks", "dependencies", "calendars", "memberships"):
        assert key in resp.data["changes"]
        bucket = resp.data["changes"][key]
        assert "created" in bucket
        assert "updated" in bucket
        assert "deleted" in bucket
        assert bucket["created"] == []  # always empty — upsert semantics


@pytest.mark.django_db
def test_sync_since_zero_returns_all_live_rows(
    authed_client: APIClient, project: Project, calendar: Calendar, membership: ProjectMembership
) -> None:
    task = Task.objects.create(project=project, name="T1", duration=2)
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_snapshot_max_version",
        return_value=10,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert resp.status_code == 200
    task_ids = [t["id"] for t in resp.data["changes"]["tasks"]["updated"]]
    assert str(task.pk) in task_ids
    project_ids = [p["id"] for p in resp.data["changes"]["projects"]["updated"]]
    assert str(project.pk) in project_ids


@pytest.mark.django_db
def test_sync_soft_deleted_task_appears_in_deleted_list(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    task = Task.objects.create(project=project, name="T2", duration=1)
    task.soft_delete()
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_snapshot_max_version",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert str(task.pk) in resp.data["changes"]["tasks"]["deleted"]
    task_updated_ids = [t["id"] for t in resp.data["changes"]["tasks"]["updated"]]
    assert str(task.pk) not in task_updated_ids


@pytest.mark.django_db
def test_sync_invalid_since_returns_400(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    resp = authed_client.get(_url(project), {"since": "not-a-number"})
    assert resp.status_code == 400


@pytest.mark.django_db
def test_sync_delta_respects_since(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    task_a = Task.objects.create(project=project, name="A", duration=1)
    version_after_a = task_a.server_version
    task_b = Task.objects.create(project=project, name="B", duration=1)

    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_snapshot_max_version",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": str(version_after_a)})
    task_ids = [t["id"] for t in resp.data["changes"]["tasks"]["updated"]]
    # Only task_b (created after version_after_a) should appear
    assert str(task_b.pk) in task_ids
    assert str(task_a.pk) not in task_ids
