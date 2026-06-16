"""Tests for the project delta sync pull endpoint."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Risk, Task
from trueppm_api.apps.sync.serializers import SyncTaskSerializer

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
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert resp.status_code == 200
    assert "changes" in resp.data
    assert "timestamp" in resp.data
    for key in ("projects", "tasks", "dependencies", "calendars", "memberships", "risks"):
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
        "_watermark",
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
        "_watermark",
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
    # Both tasks start at server_version=1 on INSERT.
    task_a = Task.objects.create(project=project, name="A", duration=1)
    task_b = Task.objects.create(project=project, name="B", duration=1)
    assert task_a.server_version == 1
    assert task_b.server_version == 1

    # Update task_a only — it now has server_version=2.
    task_a.name = "A-modified"
    task_a.save()
    task_a.refresh_from_db()
    assert task_a.server_version == 2

    # A client that last synced at version=1 should see task_a (modified to v=2)
    # but not task_b (still at v=1, unchanged since the checkpoint).
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "1"})
    task_ids = [t["id"] for t in resp.data["changes"]["tasks"]["updated"]]
    assert str(task_a.pk) in task_ids
    assert str(task_b.pk) not in task_ids


# ---------------------------------------------------------------------------
# Risks in sync payload
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_includes_risks_bucket(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert resp.status_code == 200
    assert "risks" in resp.data["changes"]
    bucket = resp.data["changes"]["risks"]
    assert "created" in bucket
    assert "updated" in bucket
    assert "deleted" in bucket
    assert bucket["created"] == []


@pytest.mark.django_db
def test_sync_returns_live_risks(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    risk = Risk.objects.create(project=project, title="Budget overrun", probability=3, impact=4)
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    risk_ids = [r["id"] for r in resp.data["changes"]["risks"]["updated"]]
    assert str(risk.pk) in risk_ids


@pytest.mark.django_db
def test_sync_risk_payload_includes_task_ids(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    task = Task.objects.create(project=project, name="T1", duration=2)
    risk = Risk.objects.create(project=project, title="Schedule slip", probability=2, impact=5)
    risk.tasks.set([task])
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    risk_data = next(r for r in resp.data["changes"]["risks"]["updated"] if r["id"] == str(risk.pk))
    assert str(task.pk) in risk_data["task_ids"]


# ---------------------------------------------------------------------------
# SyncTaskSerializer field contract
#
# Regression guard: #80 added actual_start/actual_finish to TaskSerializer but
# missed SyncTaskSerializer (fixed in #90). These assertions ensure future
# refactors cannot silently drop mobile-visible fields.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_task_payload_includes_actual_and_milestone_fields(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    task = Task.objects.create(
        project=project,
        name="Done task",
        duration=2,
        actual_start=date(2026, 2, 1),
        actual_finish=date(2026, 2, 3),
        is_milestone=False,
    )
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    payload = next(t for t in resp.data["changes"]["tasks"]["updated"] if t["id"] == str(task.pk))
    assert payload["actual_start"] == "2026-02-01"
    assert payload["actual_finish"] == "2026-02-03"
    assert payload["is_milestone"] is False


def test_sync_task_serializer_declares_required_mobile_fields() -> None:
    """Schema guard: if a field here is dropped, this test fails immediately
    instead of silently breaking the mobile pull."""
    declared = set(SyncTaskSerializer.Meta.fields)
    required = {
        "id",
        "server_version",
        "actual_start",
        "actual_finish",
        "is_milestone",
        "planned_start",
        "early_start",
        "early_finish",
        "status",
        "percent_complete",
    }
    missing = required - declared
    assert not missing, f"SyncTaskSerializer is missing mobile-critical fields: {missing}"


@pytest.mark.django_db
def test_sync_soft_deleted_risk_appears_in_deleted_list(
    authed_client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    risk = Risk.objects.create(project=project, title="Obsolete risk", probability=1, impact=1)
    risk.soft_delete()
    with patch.object(
        __import__("trueppm_api.apps.sync.views", fromlist=["ProjectSyncView"]).ProjectSyncView,
        "_watermark",
        return_value=99,
    ):
        resp = authed_client.get(_url(project), {"since": "0"})
    assert str(risk.pk) in resp.data["changes"]["risks"]["deleted"]
    risk_updated_ids = [r["id"] for r in resp.data["changes"]["risks"]["updated"]]
    assert str(risk.pk) not in risk_updated_ids
