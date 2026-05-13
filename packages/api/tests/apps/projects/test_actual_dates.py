"""Tests for actual_start / actual_finish auto-set and schedule variance (#80)."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Baseline, BaselineTask, Calendar, Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T1", duration=5)


def _patch(client: APIClient, task: Task, data: dict) -> object:  # type: ignore[type-arg]
    """PATCH a task with broadcast and scheduling mocked out."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        return client.patch(f"/api/v1/tasks/{task.pk}/", data, format="json")


def _fetch_task(client: APIClient, task: Task, project: Project) -> dict:  # type: ignore[type-arg]
    """GET the task via the list endpoint so baseline annotations are applied."""
    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    for item in r.data["results"]:
        if str(item["id"]) == str(task.pk):
            return item  # type: ignore[return-value]
    raise AssertionError(f"Task {task.pk} not found in list response")


# ---------------------------------------------------------------------------
# Auto-set on status transition
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_actual_start_set_on_in_progress(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"status": "IN_PROGRESS"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start == timezone.localdate()
    assert task.actual_finish is None


@pytest.mark.django_db
def test_actual_finish_set_on_complete(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"status": "COMPLETE"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start == timezone.localdate()
    assert task.actual_finish == timezone.localdate()


@pytest.mark.django_db
def test_actual_start_not_overwritten_on_complete(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """If actual_start was set when task went IN_PROGRESS, COMPLETE should not change it."""
    _patch(client, task, {"status": "IN_PROGRESS"})
    task.refresh_from_db()
    original_start = task.actual_start

    _patch(client, task, {"status": "COMPLETE"})
    task.refresh_from_db()
    assert task.actual_start == original_start
    assert task.actual_finish == timezone.localdate()


@pytest.mark.django_db
def test_actual_finish_cleared_on_reopen(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    _patch(client, task, {"status": "COMPLETE"})
    task.refresh_from_db()
    assert task.actual_finish is not None

    _patch(client, task, {"status": "IN_PROGRESS"})
    task.refresh_from_db()
    assert task.actual_finish is None
    assert task.actual_start is not None  # actual_start preserved


@pytest.mark.django_db
def test_on_hold_does_not_set_actual_dates(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"status": "ON_HOLD"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start is None
    assert task.actual_finish is None


# ---------------------------------------------------------------------------
# Manual override
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_explicit_actual_start_takes_precedence(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    override = "2026-03-15"
    r = _patch(client, task, {"status": "IN_PROGRESS", "actual_start": override})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start == date(2026, 3, 15)


@pytest.mark.django_db
def test_explicit_actual_finish_takes_precedence(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    override = "2026-04-20"
    r = _patch(client, task, {"status": "COMPLETE", "actual_finish": override})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_finish == date(2026, 4, 20)


@pytest.mark.django_db
def test_explicit_actual_finish_on_reopen_is_preserved(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """If PM explicitly sets actual_finish while reopening, don't clear it."""
    _patch(client, task, {"status": "COMPLETE"})

    keep_date = "2026-04-10"
    r = _patch(client, task, {"status": "IN_PROGRESS", "actual_finish": keep_date})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_finish == date(2026, 4, 10)


# ---------------------------------------------------------------------------
# No status change — actual dates not auto-set
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_non_status_patch_does_not_auto_set(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"name": "Renamed"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start is None
    assert task.actual_finish is None


# ---------------------------------------------------------------------------
# Schedule variance
# ---------------------------------------------------------------------------


def _make_baseline(project: Project, task: Task, baseline_finish: date) -> Baseline:
    """Create an active baseline with a single BaselineTask snapshot."""
    bl = Baseline.objects.create(project=project, name="B1", is_active=True)
    BaselineTask.objects.create(
        baseline=bl,
        task_id=task.pk,
        task_name=task.name,
        start=date(2026, 4, 7),
        finish=baseline_finish,
        duration=task.duration,
    )
    return bl


@pytest.mark.django_db
def test_schedule_variance_computed(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    # Baseline finish = Apr 10; actual_finish = Apr 13 → 3 days late.
    _make_baseline(project, task, date(2026, 4, 10))
    _patch(client, task, {"status": "COMPLETE", "actual_finish": "2026-04-13"})

    data = _fetch_task(client, task, project)
    assert data["schedule_variance_days"] == 3  # 3 days late vs baseline


@pytest.mark.django_db
def test_schedule_variance_null_when_incomplete(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    data = _fetch_task(client, task, project)
    assert data["schedule_variance_days"] is None


@pytest.mark.django_db
def test_schedule_variance_null_when_no_baseline(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    # Without an active baseline the metric is undefined — no plan to compare against.
    Task.objects.filter(pk=task.pk).update(early_finish=date(2026, 4, 10))
    _patch(client, task, {"status": "COMPLETE", "actual_finish": "2026-04-13"})

    data = _fetch_task(client, task, project)
    assert data["schedule_variance_days"] is None


@pytest.mark.django_db
def test_schedule_variance_negative_when_early(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    # Baseline finish = Apr 15; actual_finish = Apr 12 → 3 days early.
    _make_baseline(project, task, date(2026, 4, 15))
    _patch(client, task, {"status": "COMPLETE", "actual_finish": "2026-04-12"})

    data = _fetch_task(client, task, project)
    assert data["schedule_variance_days"] == -3  # 3 days early vs baseline


# ---------------------------------------------------------------------------
# API response includes actual date fields
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_includes_actual_date_fields(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    first = next(t for t in results if t["id"] == str(task.pk))
    assert "actual_start" in first
    assert "actual_finish" in first
    assert "schedule_variance_days" in first
    assert first["actual_start"] is None
    assert first["actual_finish"] is None


# ---------------------------------------------------------------------------
# Date-gated NOT_STARTED → IN_PROGRESS auto-transition (#336).
# Setting planned_start ≤ today on a NOT_STARTED task is the system-wide
# signal that work has begun. The same rule fires for every entry point
# (gutter promote, Gantt drag, drawer date edit, integration sync) because
# it lives in the serializer, not in any one frontend hook.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_planned_start_today_promotes_not_started_to_in_progress(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    today = timezone.localdate()
    r = _patch(client, task, {"planned_start": today.isoformat()})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == "IN_PROGRESS"
    assert task.actual_start == today  # auto-set by existing IN_PROGRESS rule


@pytest.mark.django_db
def test_planned_start_past_promotes_and_pins_actual_start(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    past = (timezone.localdate() - timedelta(days=14)).isoformat()
    r = _patch(client, task, {"planned_start": past})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == "IN_PROGRESS"
    # Past date must be preserved, not overwritten by the auto-`actual_start = today`
    assert task.actual_start == date.fromisoformat(past)


@pytest.mark.django_db
def test_planned_start_future_does_not_promote(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    future = (timezone.localdate() + timedelta(days=14)).isoformat()
    r = _patch(client, task, {"planned_start": future})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == "NOT_STARTED"
    assert task.actual_start is None


@pytest.mark.django_db
def test_explicit_status_takes_precedence_over_auto_promotion(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """A caller deliberately back-dating planned_start while keeping the card
    in To Do (e.g. data correction) must not be overridden."""
    today = timezone.localdate()
    r = _patch(
        client,
        task,
        {"planned_start": today.isoformat(), "status": "NOT_STARTED"},
    )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == "NOT_STARTED"
    assert task.actual_start is None


@pytest.mark.django_db
def test_backlog_task_is_not_auto_promoted(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """BACKLOG → IN_PROGRESS is a separate transition (issue #318); the
    date-gate only applies to NOT_STARTED ('To Do') tasks."""
    backlog_task = Task.objects.create(
        project=project, name="Backlog idea", duration=3, status="BACKLOG"
    )
    today = timezone.localdate()
    r = _patch(client, backlog_task, {"planned_start": today.isoformat()})
    assert r.status_code == 200
    backlog_task.refresh_from_db()
    assert backlog_task.status == "BACKLOG"
    assert backlog_task.actual_start is None


@pytest.mark.django_db
def test_already_in_progress_task_is_not_re_promoted(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Rescheduling an IN_PROGRESS task must not reset its actual_start."""
    original_actual = timezone.localdate() - timedelta(days=7)
    in_progress = Task.objects.create(
        project=project,
        name="Active work",
        duration=10,
        status="IN_PROGRESS",
        actual_start=original_actual,
    )
    today = timezone.localdate()
    r = _patch(client, in_progress, {"planned_start": today.isoformat()})
    assert r.status_code == 200
    in_progress.refresh_from_db()
    assert in_progress.status == "IN_PROGRESS"
    assert in_progress.actual_start == original_actual  # preserved


@pytest.mark.django_db
def test_complete_task_is_not_reopened(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Editing planned_start on a closed task must not reopen it."""
    complete = Task.objects.create(project=project, name="Done", duration=2, status="COMPLETE")
    today = timezone.localdate()
    r = _patch(client, complete, {"planned_start": today.isoformat()})
    assert r.status_code == 200
    complete.refresh_from_db()
    assert complete.status == "COMPLETE"
