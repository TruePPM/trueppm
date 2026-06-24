"""Tests for the #1054 demo on-ramp backend.

`prepare_sample_for_user` lets a contributor who loads a demo see their own work
immediately: it reassigns the program's first open sprint (ACTIVE, else earliest
PLANNED) to the loading user and returns the owning project so the load-sample
endpoint can land them on that board.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.projects.models import (
    Calendar,
    Program,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.seed.samples import (
    _first_open_sprint,
    prepare_sample_for_user,
)

pytestmark = pytest.mark.django_db

User = get_user_model()

LOAD_SAMPLE_URL = "/api/v1/programs/load-sample/"


@pytest.fixture
def user() -> Any:
    return User.objects.create_user(username="evaluator", password="pw")


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Standard")


def _project(program: Program, calendar: Calendar, name: str = "Workstream") -> Project:
    return Project.objects.create(
        name=name, start_date=date(2026, 7, 6), calendar=calendar, program=program
    )


def _sprint(project: Project, name: str, state: str, start: date) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        state=state,
        start_date=start,
        finish_date=start + timedelta(days=14),
    )


def _task(project: Project, name: str, sprint: Sprint | None, **kw: Any) -> Task:
    kw.setdefault("duration", 1)
    return Task.objects.create(project=project, name=name, sprint=sprint, **kw)


# --- _first_open_sprint -----------------------------------------------------


def test_active_sprint_wins_over_earlier_planned(calendar: Calendar) -> None:
    program = Program.objects.create(name="GA")
    project = _project(program, calendar)
    # A PLANNED sprint starts earlier, but ACTIVE must win — drop the evaluator
    # into the sprint that is live now, not the next one being planned.
    _sprint(project, "Planned-early", SprintState.PLANNED, date(2026, 7, 6))
    active = _sprint(project, "Active-later", SprintState.ACTIVE, date(2026, 8, 1))
    assert _first_open_sprint(program) == active


def test_earliest_planned_when_no_active(calendar: Calendar) -> None:
    program = Program.objects.create(name="GA")
    project = _project(program, calendar)
    early = _sprint(project, "P1", SprintState.PLANNED, date(2026, 7, 6))
    _sprint(project, "P2", SprintState.PLANNED, date(2026, 7, 20))
    assert _first_open_sprint(program) == early


def test_first_open_sprint_none_when_only_completed(calendar: Calendar) -> None:
    program = Program.objects.create(name="GA")
    project = _project(program, calendar)
    _sprint(project, "Done", SprintState.COMPLETED, date(2026, 6, 1))
    assert _first_open_sprint(program) is None


# --- prepare_sample_for_user ------------------------------------------------


def test_assigns_open_sprint_tasks_and_returns_project(user: Any, calendar: Calendar) -> None:
    program = Program.objects.create(name="GA")
    project = _project(program, calendar)
    sprint = _sprint(project, "Active", SprintState.ACTIVE, date(2026, 7, 6))
    t1 = _task(project, "Story A", sprint)
    t2 = _task(project, "Story B", sprint)
    milestone = _task(project, "Gate", sprint, is_milestone=True, duration=0)
    other = _sprint(project, "Planned", SprintState.PLANNED, date(2026, 8, 1))
    t_other = _task(project, "Later", other)

    landing = prepare_sample_for_user(program, user)

    assert landing == project
    t1.refresh_from_db()
    t2.refresh_from_db()
    assert t1.assignee_id == user.id
    assert t2.assignee_id == user.id
    # Milestones are gates, not work — never assigned.
    milestone.refresh_from_db()
    assert milestone.assignee_id is None
    # Tasks outside the first open sprint are untouched.
    t_other.refresh_from_db()
    assert t_other.assignee_id is None


def test_assignment_bumps_server_version(user: Any, calendar: Calendar) -> None:
    program = Program.objects.create(name="GA")
    project = _project(program, calendar)
    sprint = _sprint(project, "Active", SprintState.ACTIVE, date(2026, 7, 6))
    task = _task(project, "Story", sprint)
    before = task.server_version
    prepare_sample_for_user(program, user)
    task.refresh_from_db()
    assert task.server_version > before


def test_prepare_is_idempotent(user: Any, calendar: Calendar) -> None:
    program = Program.objects.create(name="GA")
    project = _project(program, calendar)
    sprint = _sprint(project, "Active", SprintState.ACTIVE, date(2026, 7, 6))
    task = _task(project, "Story", sprint)
    assert prepare_sample_for_user(program, user) == project
    task.refresh_from_db()
    sv = task.server_version
    # Second call: already assigned → skipped → no server_version churn.
    assert prepare_sample_for_user(program, user) == project
    task.refresh_from_db()
    assert task.server_version == sv


def test_prepare_returns_none_when_no_open_sprint(user: Any, calendar: Calendar) -> None:
    program = Program.objects.create(name="GA")
    project = _project(program, calendar)
    _sprint(project, "Done", SprintState.COMPLETED, date(2026, 6, 1))
    task = _task(project, "Story", None)
    assert prepare_sample_for_user(program, user) is None
    task.refresh_from_db()
    assert task.assignee_id is None


# --- load-sample endpoint envelope (integration) ----------------------------


def test_load_sample_endpoint_returns_envelope_and_assigns(user: Any) -> None:
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.post(LOAD_SAMPLE_URL, {"sample": "atlas-platform-launch"}, format="json")

    assert resp.status_code == 201
    body = resp.json()
    assert set(body) >= {"program", "landing_project_id", "sample_key"}
    assert body["sample_key"] == "atlas-platform-launch"
    # Atlas has an active sprint, so the caller lands on a real board.
    assert body["landing_project_id"]
    landing = Project.objects.get(id=body["landing_project_id"])
    assert str(landing.program_id) == body["program"]["id"]
    # The contributor now has assigned, sprint-bound work on that board.
    assert Task.objects.filter(
        project=landing, assignee=user, sprint__isnull=False, is_milestone=False
    ).exists()


def test_load_sample_waterfall_sample_has_no_landing(user: Any) -> None:
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.post(LOAD_SAMPLE_URL, {"sample": "bayside-civic-center"}, format="json")

    assert resp.status_code == 201
    # The waterfall-only sample has no open sprint → no board to land on; the
    # client falls back to the program overview.
    assert resp.json()["landing_project_id"] is None
