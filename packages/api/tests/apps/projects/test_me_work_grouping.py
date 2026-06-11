"""Tests for the My Work server-side grouping + blocker flag (#484/#476, ADR-0122).

`GET /api/v1/me/work/` now annotates each task with a ``group`` bucket
(today / this_sprint / upcoming) computed server-side, and exposes the explicit
``blocked_reason`` / ``is_blocked`` human-blocker signal. Blocked tasks sort
first within their group.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


def _project(calendar: Calendar, name: str = "P1") -> Project:
    return Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _groups(results: list[dict]) -> dict[str, list[str]]:
    """Map group → ordered task names, for ordering/bucket assertions."""
    out: dict[str, list[str]] = {}
    for row in results:
        out.setdefault(row["group"], []).append(row["name"])
    return out


@pytest.mark.django_db
def test_overdue_task_is_today(calendar: Calendar, alice: object) -> None:
    """A task whose due date is today-or-earlier and not COMPLETE → 'today'."""
    proj = _project(calendar)
    ProjectMembership.objects.create(project=proj, user=alice, role=Role.MEMBER)
    yesterday = timezone.localdate() - timedelta(days=1)
    Task.objects.create(
        project=proj, name="Overdue", duration=1, assignee=alice, planned_start=yesterday
    )

    resp = _client(alice).get("/api/v1/me/work/")
    assert resp.status_code == 200
    assert _groups(resp.data["results"]) == {"today": ["Overdue"]}


@pytest.mark.django_db
def test_active_sprint_future_task_is_this_sprint(calendar: Calendar, alice: object) -> None:
    """A task in the ACTIVE sprint, not yet due → 'this_sprint'."""
    proj = _project(calendar)
    ProjectMembership.objects.create(project=proj, user=alice, role=Role.MEMBER)
    future = timezone.localdate() + timedelta(days=5)
    sprint = Sprint.objects.create(
        project=proj,
        name="S1",
        start_date=timezone.localdate(),
        finish_date=future,
        state=SprintState.ACTIVE,
    )
    Task.objects.create(
        project=proj,
        name="Sprint work",
        duration=1,
        assignee=alice,
        sprint=sprint,
        planned_start=future,
    )

    resp = _client(alice).get("/api/v1/me/work/")
    assert _groups(resp.data["results"]) == {"this_sprint": ["Sprint work"]}


@pytest.mark.django_db
def test_non_sprint_future_task_is_upcoming(calendar: Calendar, alice: object) -> None:
    """A future task not in the active sprint → 'upcoming'."""
    proj = _project(calendar)
    ProjectMembership.objects.create(project=proj, user=alice, role=Role.MEMBER)
    future = timezone.localdate() + timedelta(days=10)
    Task.objects.create(
        project=proj, name="Later", duration=1, assignee=alice, planned_start=future
    )

    resp = _client(alice).get("/api/v1/me/work/")
    assert _groups(resp.data["results"]) == {"upcoming": ["Later"]}


@pytest.mark.django_db
def test_blocked_sorts_first_within_group(calendar: Calendar, alice: object) -> None:
    """Two overdue tasks; the blocked one comes first in the 'today' bucket."""
    proj = _project(calendar)
    ProjectMembership.objects.create(project=proj, user=alice, role=Role.MEMBER)
    yesterday = timezone.localdate() - timedelta(days=1)
    Task.objects.create(
        project=proj, name="Not blocked", duration=1, assignee=alice, planned_start=yesterday
    )
    Task.objects.create(
        project=proj,
        name="Blocked one",
        duration=1,
        assignee=alice,
        planned_start=yesterday,
        blocked_reason="Waiting on the API key",
    )

    resp = _client(alice).get("/api/v1/me/work/")
    assert _groups(resp.data["results"]) == {"today": ["Blocked one", "Not blocked"]}


@pytest.mark.django_db
def test_blocked_payload_fields(calendar: Calendar, alice: object) -> None:
    """is_blocked is derived from a non-empty blocked_reason; both are exposed."""
    proj = _project(calendar)
    ProjectMembership.objects.create(project=proj, user=alice, role=Role.MEMBER)
    Task.objects.create(
        project=proj,
        name="Blocked",
        duration=1,
        assignee=alice,
        planned_start=timezone.localdate(),
        blocked_reason="Blocked by vendor",
    )
    Task.objects.create(
        project=proj,
        name="Clear",
        duration=1,
        assignee=alice,
        planned_start=timezone.localdate(),
    )

    resp = _client(alice).get("/api/v1/me/work/")
    by_name = {r["name"]: r for r in resp.data["results"]}
    assert by_name["Blocked"]["is_blocked"] is True
    assert by_name["Blocked"]["blocked_reason"] == "Blocked by vendor"
    assert by_name["Clear"]["is_blocked"] is False
    assert by_name["Clear"]["blocked_reason"] == ""


@pytest.mark.django_db
def test_completed_overdue_task_not_in_today(calendar: Calendar, alice: object) -> None:
    """A COMPLETE task with a past due date is excluded from 'today'."""
    proj = _project(calendar)
    ProjectMembership.objects.create(project=proj, user=alice, role=Role.MEMBER)
    yesterday = timezone.localdate() - timedelta(days=1)
    Task.objects.create(
        project=proj,
        name="Done",
        duration=1,
        assignee=alice,
        planned_start=yesterday,
        status=TaskStatus.COMPLETE,
    )

    resp = _client(alice).get("/api/v1/me/work/")
    groups = _groups(resp.data["results"])
    assert "today" not in groups
    assert groups == {"upcoming": ["Done"]}
