"""Tests for the program-scoped CPM read endpoint (#1117 / ADR-0120 D3 read side).

`GET /api/v1/programs/{id}/schedule/` merges every member project's tasks and
accepted cross-project edges into one engine graph and returns the program-true
critical path on read. Coverage: program-true criticality across a cross-project
edge, ADR-0120 D5 redaction of inaccessible member projects, exclusion of pending
(unconsented) edges, the IsProgramMember gate, the empty program, and the
too-large guard.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import (
    ProgramMembership,
    ProjectMembership,
    Role,
)
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Program,
    Project,
    Task,
)

User = get_user_model()

# A Monday, so a standard Mon-Fri calendar starts work immediately.
START = date(2026, 3, 2)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


def _program_with_cross_edge(
    calendar: Calendar,
    *,
    accepted: bool,
) -> tuple[Program, Project, Project, Task, Task]:
    """One program, two projects (A→B), a cross-project FS edge A1→B1.

    ``accepted`` toggles the edge between the consented state (modeled) and the
    pending state (inert). A1 has a 5-day duration so, when the edge is modeled,
    B1 is pushed well past project B's start date.
    """
    program = Program.objects.create(name="GA Launch")
    proj_a = Project.objects.create(
        name="Security", start_date=START, calendar=calendar, program=program
    )
    proj_b = Project.objects.create(
        name="Marketing", start_date=START, calendar=calendar, program=program
    )
    a1 = Task.objects.create(project=proj_a, name="Sign-off", duration=5)
    b1 = Task.objects.create(project=proj_b, name="Go-live", duration=2)
    Dependency.objects.create(
        predecessor=a1,
        successor=b1,
        dep_type="FS",
        lag=0,
        pending_acceptance=not accepted,
        accepted_by=None,
        accepted_at=timezone.now() if accepted else None,
    )
    return program, proj_a, proj_b, a1, b1


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _by_id(payload: dict[str, object]) -> dict[str, dict[str, object]]:
    return {t["id"]: t for t in payload["tasks"]}  # type: ignore[index,union-attr]


@pytest.mark.django_db
def test_schedule_computes_program_true_critical_path(calendar: Calendar) -> None:
    """An accepted cross-project edge pushes the successor and makes both tasks
    program-true critical."""
    program, proj_a, proj_b, a1, b1 = _program_with_cross_edge(calendar, accepted=True)
    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_b, user=user, role=Role.MEMBER)

    resp = _client(user).get(f"/api/v1/programs/{program.pk}/schedule/")
    assert resp.status_code == 200, resp.data

    tasks = _by_id(resp.data)
    a, b = tasks[str(a1.pk)], tasks[str(b1.pk)]
    # The FS edge means B can't start until A finishes — program-true.
    assert b["early_start"] > a["early_finish"]
    # The cross-project chain is the program critical path.
    assert a["is_critical"] is True
    assert b["is_critical"] is True
    assert str(a1.pk) in resp.data["critical_path"]
    assert str(b1.pk) in resp.data["critical_path"]
    # The edge is reported once, flagged cross-project.
    assert resp.data["cross_project_edge_count"] == 1
    cross = [link for link in resp.data["links"] if link["is_cross_project"]]
    assert len(cross) == 1
    assert cross[0]["predecessor_id"] == str(a1.pk)
    assert cross[0]["successor_id"] == str(b1.pk)
    # Both projects are accessible lanes, neither task redacted.
    assert a["is_external"] is False and b["is_external"] is False


@pytest.mark.django_db
def test_schedule_redacts_inaccessible_project_tasks(calendar: Calendar) -> None:
    """A program member who cannot read project B sees B's task as the ADR-0120 D5
    ExternalTaskCard — title + program-true CPM dates only, no schedule internals."""
    program, proj_a, proj_b, a1, b1 = _program_with_cross_edge(calendar, accepted=True)
    user = User.objects.create_user(username="partial", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.MEMBER)
    # No ProjectMembership on B.

    resp = _client(user).get(f"/api/v1/programs/{program.pk}/schedule/")
    assert resp.status_code == 200, resp.data

    tasks = _by_id(resp.data)
    a, b = tasks[str(a1.pk)], tasks[str(b1.pk)]
    assert a["is_external"] is False
    assert "late_start" in a and "total_float_days" in a

    # B is redacted: card shape only.
    assert b["is_external"] is True
    assert b["title"] == "Go-live"
    assert b["project_name"] == "Marketing"
    # Internals are absent from the redacted card.
    assert "late_start" not in b
    assert "total_float_days" not in b
    assert "wbs_path" not in b
    # But the program-true forecast IS visible (the point of the card).
    assert b["early_start"] is not None
    assert b["is_critical"] is True
    # Lane metadata marks B inaccessible.
    lanes = {lane["id"]: lane for lane in resp.data["projects"]}
    assert lanes[str(proj_a.pk)]["accessible"] is True
    assert lanes[str(proj_b.pk)]["accessible"] is False


@pytest.mark.django_db
def test_schedule_excludes_pending_cross_edge(calendar: Calendar) -> None:
    """A pending (unconsented) cross edge is not a modeled constraint: it is absent
    from links and does not push the successor."""
    program, proj_a, proj_b, _a1, b1 = _program_with_cross_edge(calendar, accepted=False)
    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_b, user=user, role=Role.MEMBER)

    resp = _client(user).get(f"/api/v1/programs/{program.pk}/schedule/")
    assert resp.status_code == 200, resp.data

    assert resp.data["cross_project_edge_count"] == 0
    assert resp.data["links"] == []
    # B starts at its own project origin — unconstrained by the inert edge.
    b = _by_id(resp.data)[str(b1.pk)]
    assert b["early_start"] == START


@pytest.mark.django_db
def test_schedule_requires_program_membership(calendar: Calendar) -> None:
    """Project membership alone does not reach the program endpoint — program
    access is ProgramMembership-derived (matching rollup/export). The viewset
    queryset is membership-scoped, so a non-member gets 404 (existence is not
    leaked) rather than 403."""
    program, proj_a, _proj_b, _a1, _b1 = _program_with_cross_edge(calendar, accepted=True)
    user = User.objects.create_user(username="projonly", password="pw")
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.OWNER)
    # No ProgramMembership row.

    resp = _client(user).get(f"/api/v1/programs/{program.pk}/schedule/")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_schedule_empty_program_returns_lanes_no_tasks(calendar: Calendar) -> None:
    """A program whose projects have no schedulable tasks returns lane metadata and
    an empty schedule rather than erroring."""
    program = Program.objects.create(name="Empty")
    Project.objects.create(name="Shell", start_date=START, calendar=calendar, program=program)
    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)

    resp = _client(user).get(f"/api/v1/programs/{program.pk}/schedule/")
    assert resp.status_code == 200, resp.data
    assert resp.data["tasks"] == []
    assert resp.data["links"] == []
    assert resp.data["critical_path"] == []
    assert len(resp.data["projects"]) == 1


@pytest.mark.django_db
def test_schedule_too_large_program_returns_422(calendar: Calendar) -> None:
    """The on-read CPM is bounded: a program over the task guard fails loud (422)
    rather than serving a slow request."""
    program, _a, _b, _a1, _b1 = _program_with_cross_edge(calendar, accepted=True)
    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)

    with patch("trueppm_api.apps.projects.program_schedule.MAX_PROGRAM_TASKS", 1):
        resp = _client(user).get(f"/api/v1/programs/{program.pk}/schedule/")
    assert resp.status_code == 422
    assert resp.data["detail"].code == "program_schedule_too_large"
