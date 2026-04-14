"""Tests for the scheduler-runs endpoint — typed TaskRun view for recalcs (#57)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="sr_user", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="SR Project", start_date=date(2026, 1, 1), calendar=cal)


@pytest.fixture
def member_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def outsider_client(db: object) -> APIClient:
    outsider = User.objects.create_user(username="sr_outsider", password="pw")
    c = APIClient()
    c.force_authenticate(user=outsider)
    return c


def _make_run(
    project: Project,
    *,
    status: TaskRunStatus = TaskRunStatus.SUCCESS,
    task_name: str = "scheduling.recalculate",
    initiated_by: object | None = None,
    started_at: datetime | None = None,
    result_summary: dict[str, object] | None = None,
) -> TaskRun:
    return TaskRun.objects.create(
        task_name=task_name,
        celery_task_id="x",
        project=project,
        initiated_by=initiated_by,
        status=status,
        started_at=started_at,
        completed_at=started_at,
        result_summary=result_summary,
    )


@pytest.mark.django_db
def test_list_filters_to_scheduling_recalculate_only(
    member_client: APIClient, project: Project, user: object
) -> None:
    """Other TaskRun records must not leak into the scheduler-runs endpoint."""
    _make_run(project, task_name="scheduling.recalculate", initiated_by=user)
    _make_run(project, task_name="exports.csv", initiated_by=user)

    resp = member_client.get(f"/api/v1/projects/{project.pk}/scheduler-runs/")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1


@pytest.mark.django_db
def test_list_returns_typed_result_summary_and_username(
    member_client: APIClient, project: Project, user: object
) -> None:
    _make_run(
        project,
        initiated_by=user,
        result_summary={
            "project_finish": "2026-06-01",
            "critical_path": ["abc", "def"],
        },
    )

    resp = member_client.get(f"/api/v1/projects/{project.pk}/scheduler-runs/")
    assert resp.status_code == 200
    row = resp.json()[0]
    assert row["initiated_by_username"] == "sr_user"
    assert row["result_summary"]["project_finish"] == "2026-06-01"
    assert row["result_summary"]["critical_path"] == ["abc", "def"]
    # Exposed fields only — no celery_task_id, no raw initiated_by FK
    assert "celery_task_id" not in row
    assert "initiated_by" not in row


@pytest.mark.django_db
def test_list_handles_null_result_summary(
    member_client: APIClient, project: Project, user: object
) -> None:
    """Failed runs never call set_result — result_summary stays null."""
    _make_run(project, status=TaskRunStatus.FAILED, initiated_by=user, result_summary=None)
    resp = member_client.get(f"/api/v1/projects/{project.pk}/scheduler-runs/")
    assert resp.status_code == 200
    assert resp.json()[0]["result_summary"] is None


@pytest.mark.django_db
def test_status_filter_accepts_multiple(
    member_client: APIClient, project: Project, user: object
) -> None:
    _make_run(project, status=TaskRunStatus.SUCCESS, initiated_by=user)
    _make_run(project, status=TaskRunStatus.FAILED, initiated_by=user)
    _make_run(project, status=TaskRunStatus.RUNNING, initiated_by=user)

    resp = member_client.get(
        f"/api/v1/projects/{project.pk}/scheduler-runs/?status=success&status=failed"
    )
    assert resp.status_code == 200
    statuses = sorted(r["status"] for r in resp.json())
    assert statuses == ["failed", "success"]


@pytest.mark.django_db
def test_invalid_status_is_ignored(
    member_client: APIClient, project: Project, user: object
) -> None:
    _make_run(project, status=TaskRunStatus.SUCCESS, initiated_by=user)
    resp = member_client.get(f"/api/v1/projects/{project.pk}/scheduler-runs/?status=garbage")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


@pytest.mark.django_db
def test_date_range_filter(member_client: APIClient, project: Project, user: object) -> None:
    old = datetime(2026, 1, 1, tzinfo=UTC)
    new = datetime(2026, 3, 1, tzinfo=UTC)
    _make_run(project, initiated_by=user, started_at=old)
    _make_run(project, initiated_by=user, started_at=new)

    mid = (old + timedelta(days=30)).isoformat()
    resp = member_client.get(f"/api/v1/projects/{project.pk}/scheduler-runs/?started_after={mid}")
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["started_at"].startswith("2026-03-01")


@pytest.mark.django_db
def test_default_ordering_is_newest_first(
    member_client: APIClient, project: Project, user: object
) -> None:
    r1 = _make_run(project, initiated_by=user)
    r2 = _make_run(project, initiated_by=user)
    resp = member_client.get(f"/api/v1/projects/{project.pk}/scheduler-runs/")
    ids = [row["id"] for row in resp.json()]
    assert ids == [str(r2.pk), str(r1.pk)]


@pytest.mark.django_db
def test_non_member_cannot_list(outsider_client: APIClient, project: Project) -> None:
    resp = outsider_client.get(f"/api/v1/projects/{project.pk}/scheduler-runs/")
    assert resp.status_code in (403, 404)


@pytest.mark.django_db
def test_anonymous_cannot_list(project: Project) -> None:
    resp = APIClient().get(f"/api/v1/projects/{project.pk}/scheduler-runs/")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_retrieve_single_run(member_client: APIClient, project: Project, user: object) -> None:
    run = _make_run(project, initiated_by=user)
    resp = member_client.get(f"/api/v1/projects/{project.pk}/scheduler-runs/{run.pk}/")
    assert resp.status_code == 200
    assert resp.json()["id"] == str(run.pk)
