"""Tests for server-authoritative resize: target finish date → working-day duration (#951).

The Gantt bar-resize handler sends ``planned_finish`` (the date the user dropped the
bar's right edge on) instead of a calendar-day duration. The serializer derives the
stored working-day ``duration`` from the project calendar so a bar dragged across a
weekend or holiday commits the correct working-day count, not the inflated calendar
span. ``planned_finish`` is write-only and never persisted.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.projects.services import working_day_duration

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    # Default working_days = 31 (Mon–Fri).
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
    # early_start = Mon 2026-04-06; a CPM-scheduled task with no committed
    # planned_start (the common resize case — the bar paints from early_start).
    return Task.objects.create(project=project, name="T1", duration=3, early_start=date(2026, 4, 6))


# Side effects to suppress during a task PATCH (board broadcast + CPM recalc).
_BROADCAST = "trueppm_api.apps.sync.broadcast.broadcast_board_event"
_RECALC = "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"


# ---------------------------------------------------------------------------
# Service helper — working_day_duration
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_working_day_duration_skips_weekend(calendar: Calendar) -> None:
    # Mon 2026-04-06 → Mon 2026-04-13 spans one weekend: 8 calendar days but
    # only 6 working days (Mon–Fri + the following Mon).
    assert working_day_duration(date(2026, 4, 6), date(2026, 4, 13), calendar) == 6


@pytest.mark.django_db
def test_working_day_duration_single_day(calendar: Calendar) -> None:
    assert working_day_duration(date(2026, 4, 6), date(2026, 4, 6), calendar) == 1


def test_working_day_duration_defaults_to_mon_fri_without_calendar() -> None:
    # No calendar → Mon–Fri mask (31). Same span, same answer.
    assert working_day_duration(date(2026, 4, 6), date(2026, 4, 13), None) == 6


# ---------------------------------------------------------------------------
# API — resize via planned_finish
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_planned_finish_commits_working_day_duration(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    with patch(_BROADCAST), patch(_RECALC):
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_finish": "2026-04-13"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    # 6 working days — NOT the 8 raw calendar days the old client math committed.
    assert task.duration == 6


@pytest.mark.django_db
def test_patch_planned_finish_same_as_start_is_one_day(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    with patch(_BROADCAST), patch(_RECALC):
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_finish": "2026-04-06"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.duration == 1


@pytest.mark.django_db
def test_patch_planned_finish_before_start_rejected(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"planned_finish": "2026-04-03"},
        format="json",
    )
    assert r.status_code == 400
    assert "planned_finish" in r.data


@pytest.mark.django_db
def test_patch_planned_finish_without_any_start_rejected(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    # No early_start and no planned_start → the server cannot derive a duration.
    t = Task.objects.create(project=project, name="No start", duration=2)
    r = client.patch(
        f"/api/v1/tasks/{t.pk}/",
        {"planned_finish": "2026-04-13"},
        format="json",
    )
    assert r.status_code == 400
    assert "planned_finish" in r.data


@pytest.mark.django_db
def test_patch_planned_finish_absurd_future_rejected(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    # An unbounded finish date would burn CPU in the day-by-day working-day count
    # (authenticated DoS) — the serializer rejects a >100-year span with a 400
    # rather than loop millions of times (#951 security gate).
    r = client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"planned_finish": "9999-12-31"},
        format="json",
    )
    assert r.status_code == 400
    assert "planned_finish" in r.data


@pytest.mark.django_db
def test_patch_planned_start_in_same_request_takes_precedence(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    # A combined move+resize: planned_start in the same body anchors the duration,
    # not the prior early_start. Wed 2026-04-08 → Mon 2026-04-13 = 4 working days.
    with patch(_BROADCAST), patch(_RECALC):
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_start": "2026-04-08", "planned_finish": "2026-04-13"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.duration == 4


@pytest.mark.django_db
def test_milestone_ignores_planned_finish(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    m = Task.objects.create(
        project=project, name="Gate", duration=0, is_milestone=True, early_start=date(2026, 4, 6)
    )
    with patch(_BROADCAST), patch(_RECALC):
        r = client.patch(
            f"/api/v1/tasks/{m.pk}/",
            {"planned_finish": "2026-04-13"},
            format="json",
        )
    assert r.status_code == 200
    m.refresh_from_db()
    # Milestone duration stays pinned at 0 — a finish date never inflates it.
    assert m.duration == 0


@pytest.mark.django_db
def test_planned_finish_is_write_only_not_in_representation(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    first = next(t for t in results if t["id"] == str(task.pk))
    assert "planned_finish" not in first


# ---------------------------------------------------------------------------
# #4170 — the derivation counts on the COMPOSED calendar CPM schedules with
# ---------------------------------------------------------------------------


def _patch_finish(client: APIClient, task: Task, finish: str) -> int:
    with patch(_BROADCAST), patch(_RECALC):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"planned_finish": finish}, format="json")
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    return int(task.duration)


@pytest.mark.django_db
def test_planned_finish_excludes_a_holiday_in_the_span(
    client: APIClient, task: Task, calendar: Calendar, membership: ProjectMembership
) -> None:
    """Mon 04-06 → Fri 04-10 with Thu 04-09 off is 4 working days, so the task the
    CPM pass lays out finishes on the handle date instead of the Monday after."""
    from trueppm_api.apps.projects.models import CalendarException

    CalendarException.objects.create(
        calendar=calendar, exc_start=date(2026, 4, 9), exc_end=date(2026, 4, 9)
    )
    assert _patch_finish(client, task, "2026-04-10") == 4


@pytest.mark.django_db
def test_planned_finish_dropped_on_a_holiday_snaps_back(
    client: APIClient, task: Task, calendar: Calendar, membership: ProjectMembership
) -> None:
    """A drop ON a non-working day adds nothing: the finish is the working day before."""
    from trueppm_api.apps.projects.models import CalendarException

    CalendarException.objects.create(
        calendar=calendar, exc_start=date(2026, 4, 9), exc_end=date(2026, 4, 9)
    )
    # Mon 06, Tue 07, Wed 08 — Thu 09 is the holiday the handle sits on.
    assert _patch_finish(client, task, "2026-04-09") == 3


@pytest.mark.django_db
def test_planned_finish_counts_a_layer_holiday_and_narrowed_week(
    client: APIClient, task: Task, project: Project, membership: ProjectMembership
) -> None:
    """An overlay layer's holiday and its narrower week are applied too (ADR-0251)."""
    from trueppm_api.apps.projects.models import CalendarException, ProjectCalendarLayer

    mon_thu = Calendar.objects.create(name="Mon-Thu", working_days=0b0001111)
    CalendarException.objects.create(
        calendar=mon_thu, exc_start=date(2026, 4, 7), exc_end=date(2026, 4, 7)
    )
    ProjectCalendarLayer.objects.create(
        project=project, calendar=mon_thu, role="holidays", sort_order=0
    )
    # Mon 06 .. Mon 13 on Mon-Thu minus Tue 07: 06, 08, 09, 13.
    assert _patch_finish(client, task, "2026-04-13") == 4


@pytest.mark.django_db
def test_planned_finish_uses_the_inherited_program_calendar(user: object) -> None:
    """A project with no calendar of its own counts on its program's (ADR-0441)."""
    from trueppm_api.apps.projects.models import Program

    six_day = Calendar.objects.create(name="Six", working_days=0b0111111)
    program = Program.objects.create(name="Prog", calendar=six_day)
    project = Project.objects.create(name="Inh", start_date=date(2026, 4, 1), program=program)
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    t = Task.objects.create(project=project, name="T", duration=3, early_start=date(2026, 4, 6))
    c = APIClient()
    c.force_authenticate(user=user)
    # Mon 06 .. Sat 11 on Mon-Sat is 6 working days (5 on the Mon-Fri default).
    assert _patch_finish(c, t, "2026-04-11") == 6


@pytest.mark.django_db
def test_derived_duration_round_trips_through_cpm(
    client: APIClient,
    task: Task,
    calendar: Calendar,
    project: Project,
    membership: ProjectMembership,
) -> None:
    """The stored duration, laid out by the real CPM pass, finishes on the handle."""
    from trueppm_api.apps.projects.models import CalendarException
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    CalendarException.objects.create(
        calendar=calendar, exc_start=date(2026, 4, 9), exc_end=date(2026, 4, 9)
    )
    project.start_date = date(2026, 4, 6)
    project.status_date = date(2026, 4, 6)
    project.save()
    _patch_finish(client, task, "2026-04-10")
    _run_schedule(str(project.pk), tracker=None)
    task.refresh_from_db()
    assert task.early_finish == date(2026, 4, 10)
