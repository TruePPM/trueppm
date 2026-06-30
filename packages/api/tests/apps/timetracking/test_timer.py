"""Tests for the running timer (ADR-0185 §4, #1258).

GET reconcile, start/stop lifecycle, the second-start atomic stop+log, the duplicate-stop
409, the stale ceiling cap, and the RBAC gate on start.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.timetracking.models import ActiveTimer, TimeEntry

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


def _project(calendar: Calendar, name: str = "P1") -> Project:
    return Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)


def _member(project: Project, user: object, role: int = Role.MEMBER) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=role)


def _task(project: Project, name: str = "T1") -> Task:
    return Task.objects.create(project=project, name=name, duration=1)


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# GET reconcile
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_get_timer_inactive(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    resp = _client(alice).get("/api/v1/me/timer/")
    assert resp.status_code == 200
    assert resp.data == {"active": False}


@pytest.mark.django_db
def test_get_timer_active_reports_elapsed(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    ActiveTimer.objects.create(
        user=alice, task=task, started_at=timezone.now() - timedelta(minutes=10)
    )

    resp = _client(alice).get("/api/v1/me/timer/")

    assert resp.status_code == 200
    assert resp.data["active"] is True
    assert resp.data["elapsed_seconds"] >= 600
    assert resp.data["stale"] is False
    assert resp.data["task_short_id"] == task.short_id


@pytest.mark.django_db
def test_get_timer_marks_stale_past_ceiling(
    calendar: Calendar, alice: object, settings: object
) -> None:
    settings.TIMETRACKING_TIMER_MAX_MINUTES = 600  # type: ignore[attr-defined]
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    ActiveTimer.objects.create(
        user=alice, task=task, started_at=timezone.now() - timedelta(hours=11)
    )

    resp = _client(alice).get("/api/v1/me/timer/")

    assert resp.data["stale"] is True


# ---------------------------------------------------------------------------
# start / stop lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_start_then_stop_logs_entry(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    client = _client(alice)

    start = client.post("/api/v1/me/timer/start", {"task": str(task.pk)}, format="json")
    assert start.status_code == 201
    assert start.data["finalized_entry"] is None
    assert ActiveTimer.objects.filter(user=alice).count() == 1

    stop = client.post("/api/v1/me/timer/stop")
    assert stop.status_code == 201
    assert stop.data["source"] == "timer"
    assert stop.data["minutes"] >= 1
    assert ActiveTimer.objects.filter(user=alice).count() == 0
    assert TimeEntry.objects.filter(task=task, user=alice, source="timer").count() == 1


@pytest.mark.django_db
def test_second_start_atomically_stops_and_logs_prior(calendar: Calendar, alice: object) -> None:
    """#1415 second-start: the running timer is stopped+logged, the entry returned."""
    proj = _project(calendar)
    _member(proj, alice)
    t1 = _task(proj, "A")
    t2 = _task(proj, "B")
    # First timer started 5 min ago.
    ActiveTimer.objects.create(
        user=alice, task=t1, started_at=timezone.now() - timedelta(minutes=5)
    )

    resp = _client(alice).post("/api/v1/me/timer/start", {"task": str(t2.pk)}, format="json")

    assert resp.status_code == 201
    # Exactly one timer remains, and it is the new one (task B).
    assert ActiveTimer.objects.filter(user=alice).count() == 1
    assert str(ActiveTimer.objects.get(user=alice).task_id) == str(t2.pk)
    # The prior timer was auto-logged and rides back for the undo toast.
    assert resp.data["finalized_entry"] is not None
    assert str(resp.data["finalized_entry"]["task"]) == str(t1.pk)
    assert TimeEntry.objects.filter(task=t1, user=alice, source="timer").count() == 1


@pytest.mark.django_db
def test_duplicate_stop_returns_409(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    client = _client(alice)
    client.post("/api/v1/me/timer/start", {"task": str(task.pk)}, format="json")
    client.post("/api/v1/me/timer/stop")

    second = client.post("/api/v1/me/timer/stop")

    assert second.status_code == 409
    # No double-log: exactly one timer entry exists.
    assert TimeEntry.objects.filter(task=task, source="timer").count() == 1


@pytest.mark.django_db
def test_stop_caps_minutes_at_ceiling(calendar: Calendar, alice: object, settings: object) -> None:
    """A timer left running over a weekend logs the ceiling, not thousands of minutes."""
    settings.TIMETRACKING_TIMER_MAX_MINUTES = 600  # type: ignore[attr-defined]
    proj = _project(calendar)
    _member(proj, alice)
    task = _task(proj)
    ActiveTimer.objects.create(user=alice, task=task, started_at=timezone.now() - timedelta(days=3))

    resp = _client(alice).post("/api/v1/me/timer/stop")

    assert resp.status_code == 201
    assert resp.data["minutes"] == 600


@pytest.mark.django_db
def test_start_on_viewer_is_403(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)
    _member(proj, alice, Role.VIEWER)
    task = _task(proj)
    resp = _client(alice).post("/api/v1/me/timer/start", {"task": str(task.pk)}, format="json")
    assert resp.status_code == 403
    assert not ActiveTimer.objects.filter(user=alice).exists()


@pytest.mark.django_db
def test_start_on_cross_project_task_is_404(calendar: Calendar, alice: object) -> None:
    proj = _project(calendar)  # alice is NOT a member
    task = _task(proj)
    resp = _client(alice).post("/api/v1/me/timer/start", {"task": str(task.pk)}, format="json")
    assert resp.status_code == 404
