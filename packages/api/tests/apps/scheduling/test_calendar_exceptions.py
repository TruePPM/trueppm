"""Tests proving CalendarException holiday/shutdown ranges reach the engine (#1491).

Before this fix, every call site that built a ``trueppm_scheduler.Calendar`` from
a Django ``Calendar`` passed only ``working_days``/``hours_per_day``/``timezone``
and silently dropped ``exceptions`` — so a project with a configured holiday or
shutdown scheduled straight through it. These tests build a project whose task
duration spans a single-day ``CalendarException`` and assert the CPM early/late
dates — and the Monte Carlo percentiles — shift by exactly the one blocked day,
proving the exception is now honored rather than merely "doesn't crash".
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, CalendarException, Project, Task

User = get_user_model()

# Monday, so a standard Mon-Fri calendar starts work immediately.
START = date(2026, 3, 2)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Holiday Project", start_date=START, calendar=calendar)


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="cal_exc_user", password="pw")


@pytest.fixture
def member_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Deterministic CPM pass (scheduling.tasks._run_schedule)
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_cpm_skips_calendar_exception_date_range(project: Project, calendar: Calendar) -> None:
    """A 5-working-day task finishes one day later when Wednesday is a holiday.

    Without any exception, Mon 2026-03-02 + 5 working days (Mon-Fri) finishes Fri
    2026-03-06. Blocking Wed 2026-03-04 as a ``CalendarException`` pushes the
    finish to Mon 2026-03-09 — proving the CPM pass reads ``exceptions``, not just
    that it runs without error.
    """
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    task = Task.objects.create(project=project, name="Build", duration=5)

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))
        task.refresh_from_db()
        assert task.early_start == date(2026, 3, 2)
        assert task.early_finish == date(2026, 3, 6), (
            "sanity baseline: 5 working days from a Monday with no exceptions"
        )

        CalendarException.objects.create(
            calendar=calendar,
            exc_start=date(2026, 3, 4),
            exc_end=date(2026, 3, 4),
            description="Company holiday",
        )

        _run_schedule(str(project.pk))
        task.refresh_from_db()
        assert task.early_start == date(2026, 3, 2)
        assert task.early_finish == date(2026, 3, 9), (
            "the holiday must push the finish out by exactly the one blocked working day"
        )


# ---------------------------------------------------------------------------
# Monte Carlo (scheduling.views.run_monte_carlo)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_monte_carlo_percentiles_shift_around_calendar_exception(
    member_client: APIClient,
    project: Project,
    calendar: Calendar,
) -> None:
    """P50/P80/P95 shift by the blocked day for a deterministic (non-PERT) task.

    A single duration-only task (no three-point estimate) drives a flat forecast
    where p50 == p80 == p95 == the deterministic CPM finish (see
    ``test_monte_carlo.py``'s "flat forecast" cases) — an easy, exact assertion
    surface for whether Monte Carlo's calendar input includes ``exceptions``.
    """
    # Anchor the data date to the project start (not None, which run_monte_carlo
    # defaults to the wall-clock "today") so the assertion is deterministic.
    project.status_date = START
    project.save(update_fields=["status_date"])
    Task.objects.create(project=project, name="Build", duration=5)

    r = member_client.post(
        f"/api/v1/projects/{project.pk}/monte-carlo/",
        {"n_simulations": 100},
        format="json",
    )
    assert r.status_code == 200
    assert r.data["p50"] == r.data["p80"] == r.data["p95"] == "2026-03-06"

    CalendarException.objects.create(
        calendar=calendar,
        exc_start=date(2026, 3, 4),
        exc_end=date(2026, 3, 4),
        description="Company holiday",
    )

    r = member_client.post(
        f"/api/v1/projects/{project.pk}/monte-carlo/",
        {"n_simulations": 100},
        format="json",
    )
    assert r.status_code == 200
    assert r.data["p50"] == r.data["p80"] == r.data["p95"] == "2026-03-09", (
        "Monte Carlo must read the calendar's exceptions the same way CPM does — "
        "otherwise the forecast silently schedules straight through a holiday"
    )


# ---------------------------------------------------------------------------
# Program-scoped read CPM (projects.program_schedule.build_program_schedule_graph)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_program_schedule_skips_calendar_exception_date_range(calendar: Calendar) -> None:
    """The merged program-scoped CPM read also honors a member project's exceptions."""
    from trueppm_api.apps.projects.models import Program

    program = Program.objects.create(name="Launch")
    proj = Project.objects.create(
        name="Holiday Project", start_date=START, calendar=calendar, program=program
    )
    task = Task.objects.create(project=proj, name="Build", duration=5)

    user = User.objects.create_user(username="cal_exc_prog_user", password="pw")
    from trueppm_api.apps.access.models import ProgramMembership

    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)

    resp = c.get(f"/api/v1/programs/{program.pk}/schedule/")
    assert resp.status_code == 200
    row = next(t for t in resp.data["tasks"] if t["id"] == str(task.pk))
    assert row["early_finish"] == date(2026, 3, 6)

    CalendarException.objects.create(
        calendar=calendar,
        exc_start=date(2026, 3, 4),
        exc_end=date(2026, 3, 4),
        description="Company holiday",
    )

    resp = c.get(f"/api/v1/programs/{program.pk}/schedule/")
    assert resp.status_code == 200
    row = next(t for t in resp.data["tasks"] if t["id"] == str(task.pk))
    assert row["early_finish"] == date(2026, 3, 9), (
        "the merged program-scoped CPM read must also honor a member project's "
        "CalendarException ranges"
    )
