"""Tests for the scheduler-runs endpoint — typed TaskRun view for recalcs (#57)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any

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


def _url(project: Project, suffix: str = "") -> str:
    return f"/api/v1/projects/{project.pk}/scheduler-runs/{suffix}"


def _results(resp: object) -> list[dict[str, object]]:
    """Unwrap paginated response list."""
    return resp.json()["results"]  # type: ignore[union-attr]


@pytest.mark.django_db
def test_list_filters_to_scheduling_recalculate_only(
    member_client: APIClient, project: Project, user: object
) -> None:
    """Other TaskRun records must not leak into the scheduler-runs endpoint."""
    _make_run(project, task_name="scheduling.recalculate", initiated_by=user)
    _make_run(project, task_name="exports.csv", initiated_by=user)

    resp = member_client.get(_url(project))
    assert resp.status_code == 200
    assert len(_results(resp)) == 1


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

    resp = member_client.get(_url(project))
    assert resp.status_code == 200
    row = _results(resp)[0]
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
    resp = member_client.get(_url(project))
    assert resp.status_code == 200
    assert _results(resp)[0]["result_summary"] is None


@pytest.mark.django_db
def test_status_filter_accepts_multiple(
    member_client: APIClient, project: Project, user: object
) -> None:
    _make_run(project, status=TaskRunStatus.SUCCESS, initiated_by=user)
    _make_run(project, status=TaskRunStatus.FAILED, initiated_by=user)
    _make_run(project, status=TaskRunStatus.RUNNING, initiated_by=user)

    resp = member_client.get(_url(project) + "?status=success&status=failed")
    assert resp.status_code == 200
    statuses = sorted(r["status"] for r in _results(resp))
    assert statuses == ["failed", "success"]


@pytest.mark.django_db
def test_invalid_status_is_ignored(
    member_client: APIClient, project: Project, user: object
) -> None:
    _make_run(project, status=TaskRunStatus.SUCCESS, initiated_by=user)
    resp = member_client.get(_url(project) + "?status=garbage")
    assert resp.status_code == 200
    assert len(_results(resp)) == 1


@pytest.mark.django_db
def test_date_range_filter(member_client: APIClient, project: Project, user: object) -> None:
    old = datetime(2026, 1, 1, tzinfo=UTC)
    new = datetime(2026, 3, 1, tzinfo=UTC)
    _make_run(project, initiated_by=user, started_at=old)
    _make_run(project, initiated_by=user, started_at=new)

    # Use Z-suffix format to avoid + → space URL-encoding issue.
    mid = (old + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    resp = member_client.get(_url(project) + f"?started_after={mid}")
    assert resp.status_code == 200
    rows = _results(resp)
    assert len(rows) == 1
    assert rows[0]["started_at"].startswith("2026-03-01")


@pytest.mark.django_db
def test_default_ordering_is_newest_first(
    member_client: APIClient, project: Project, user: object
) -> None:
    r1 = _make_run(project, initiated_by=user)
    r2 = _make_run(project, initiated_by=user)
    resp = member_client.get(_url(project))
    ids = [row["id"] for row in _results(resp)]
    assert ids == [str(r2.pk), str(r1.pk)]


@pytest.mark.django_db
def test_non_member_gets_403(outsider_client: APIClient, project: Project) -> None:
    """#254: IsProjectMember.has_permission enforces project membership on
    project-nested routes. A non-member receives 403 — not an empty 200 — so
    project IDs cannot be probed by enumeration."""
    resp = outsider_client.get(_url(project))
    assert resp.status_code == 403


@pytest.mark.django_db
def test_anonymous_cannot_list(project: Project) -> None:
    resp = APIClient().get(_url(project))
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_retrieve_single_run(member_client: APIClient, project: Project, user: object) -> None:
    run = _make_run(project, initiated_by=user)
    resp = member_client.get(_url(project, f"{run.pk}/"))
    assert resp.status_code == 200
    assert resp.json()["id"] == str(run.pk)


def _project_with_summary_start_link(project: Project) -> Any:
    """A project holding an SS edge from a summary, as written before the write gate."""
    from trueppm_api.apps.projects.models import Dependency, Task

    s = Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
    Task.objects.create(project=project, name="A", duration=2, wbs_path="1.1")
    c = Task.objects.create(project=project, name="C", duration=1, wbs_path="2")
    return Dependency.objects.create(predecessor=s, successor=c, dep_type="SS")


def _dispatched_request(project: Project) -> Any:
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus

    return ScheduleRequest.objects.create(
        project=project,
        status=ScheduleRequestStatus.DISPATCHED,
        dispatched_at=datetime.now(UTC) - timedelta(minutes=30),
    )


@pytest.mark.django_db
def test_recalculate_with_a_preexisting_summary_start_link_fails_the_run_not_the_task(
    project: Project,
    django_capture_on_commit_callbacks: Any,
) -> None:
    """An SS edge from a summary that predates the write gate ends the task cleanly.

    The run is recorded FAILED with the engine's message in ``error_detail``, the
    ``task_run_failed`` event carries it, and the task itself neither raises nor
    loses its dead-letter record. The schedule is not stamped as recalculated.
    """
    from unittest.mock import patch

    from trueppm_api.apps.scheduling.models import (
        FailedTask,
        ScheduleRequestStatus,
    )
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    _project_with_summary_start_link(project)
    request = _dispatched_request(project)

    with (
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event") as bc,
        django_capture_on_commit_callbacks(execute=True),
    ):
        result = recalculate_schedule.apply(args=[str(project.pk)])

    assert result.successful()
    run = TaskRun.objects.get(project=project, task_name="scheduling.recalculate")
    assert run.status == TaskRunStatus.FAILED
    assert "link to a specific leaf task instead" in run.error_detail
    events = [c.kwargs["event_type"] for c in bc.call_args_list]
    assert "task_run_failed" in events
    assert FailedTask.objects.filter(project_id=project.pk).exists()
    request.refresh_from_db()
    assert request.status == ScheduleRequestStatus.DONE
    project.refresh_from_db()
    assert project.recalculated_at is None


@pytest.mark.django_db
def test_drain_does_not_redispatch_a_run_the_scheduler_refused(project: Project) -> None:
    """The outbox row is retired as done, so the drain neither re-runs nor re-alerts it."""
    from unittest.mock import patch

    from trueppm_api.apps.scheduling.models import FailedTask
    from trueppm_api.apps.scheduling.tasks import _do_drain, recalculate_schedule

    _project_with_summary_start_link(project)
    _dispatched_request(project)
    recalculate_schedule.apply(args=[str(project.pk)])
    assert FailedTask.objects.filter(project_id=project.pk).count() == 1

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay") as delay:
        _do_drain()
        _do_drain()

    delay.assert_not_called()
    assert FailedTask.objects.filter(project_id=project.pk).count() == 1


@pytest.mark.django_db
def test_repairing_the_edge_after_a_refused_run_schedules_again(
    project: Project, user: object, django_capture_on_commit_callbacks: Any
) -> None:
    """Retiring the refused row must not wedge the project: deleting the edge recovers it.

    Goes through the real DELETE endpoint. A row left DISPATCHED would block the new
    request from being promoted (one dispatched row per project), so the new request
    reaching DISPATCHED is what discriminates.
    """
    from unittest.mock import patch

    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    edge = _project_with_summary_start_link(project)
    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    _dispatched_request(project)
    recalculate_schedule.apply(args=[str(project.pk)])
    client = APIClient()
    client.force_authenticate(user=user)

    with (
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay") as delay,
        django_capture_on_commit_callbacks(execute=True),
    ):
        delay.return_value.id = "task-1"
        r = client.delete(f"/api/v1/dependencies/{edge.pk}/")

    assert r.status_code == 204
    delay.assert_called_once_with(str(project.pk))
    assert ScheduleRequest.objects.filter(
        project=project, status=ScheduleRequestStatus.DISPATCHED
    ).exists()
    assert not ScheduleRequest.objects.filter(
        project=project, status=ScheduleRequestStatus.PENDING
    ).exists()


@pytest.mark.django_db
def test_a_refused_run_leaves_the_system_health_outbox_card_clean(project: Project) -> None:
    from trueppm_api.apps.observability.selectors import STATUS_OK, _outbox_card
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    _project_with_summary_start_link(project)
    _dispatched_request(project)
    recalculate_schedule.apply(args=[str(project.pk)])

    assert _outbox_card()["status"] == STATUS_OK
