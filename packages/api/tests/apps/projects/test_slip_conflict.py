"""Tests for the cross-project sprint-boundary firewall (#1117 / ADR-0120 D4).

When the program pass pushes a committed task in an ACTIVE sprint past its sprint
boundary because of an accepted cross-project edge, a ``CrossProjectSlipConflict`` is
upserted for the downstream team to acknowledge — honest math, team-owned resolution.
Coverage: detection + strict boundary, sprint_pending / non-active exclusions,
deterministic single-row attribution, the auto-resolve and re-slip lifecycle, the
acknowledge facet gate, list scoping, and the ADR-0106 unmodeled-dependency integration.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    CrossProjectSlipConflict,
    Dependency,
    Program,
    Project,
    SlipConflictResolution,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.services import _unmodeled_predecessors
from trueppm_api.apps.scheduling.tasks import _run_program_schedule

User = get_user_model()

START = date(2026, 3, 2)  # a Monday


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


def _scenario(
    calendar: Calendar,
    *,
    upstream_duration: int = 20,
    sprint_finish: date | None = None,
    sprint_state: str = SprintState.ACTIVE,
    sprint_pending: bool = False,
) -> tuple[Program, Project, Project, Task, Task, Sprint, Dependency]:
    """Upstream A1 (long) gating downstream B1, which sits in a B-owned sprint.

    With the default 20-day upstream task and a 10-day sprint window, the program
    pass pushes B1 well past the sprint's finish — a boundary breach.
    """
    program = Program.objects.create(name="GA Launch")
    proj_a = Project.objects.create(
        name="Security", start_date=START, calendar=calendar, program=program
    )
    proj_b = Project.objects.create(
        name="Marketing", start_date=START, calendar=calendar, program=program
    )
    sprint = Sprint.objects.create(
        project=proj_b,
        name="Launch sprint",
        start_date=START,
        finish_date=sprint_finish or (START + timedelta(days=10)),
        state=sprint_state,
    )
    a1 = Task.objects.create(project=proj_a, name="Sign-off", duration=upstream_duration)
    b1 = Task.objects.create(
        project=proj_b, name="Go-live", duration=2, sprint=sprint, sprint_pending=sprint_pending
    )
    dep = Dependency.objects.create(
        predecessor=a1, successor=b1, dep_type="FS", lag=0, accepted_at=timezone.now()
    )
    return program, proj_a, proj_b, a1, b1, sprint, dep


@pytest.mark.django_db
def test_conflict_detected_on_boundary_breach(calendar: Calendar) -> None:
    program, _a, _b, _a1, b1, sprint, dep = _scenario(calendar)

    _run_program_schedule(str(program.pk))

    b1.refresh_from_db()
    conflict = CrossProjectSlipConflict.objects.get(sprint=sprint, task=b1)
    assert conflict.resolution == SlipConflictResolution.UNRESOLVED
    assert conflict.acknowledged_at is None
    assert conflict.dependency_id == dep.pk
    assert conflict.pushed_to == b1.early_finish
    assert conflict.is_open is True


@pytest.mark.django_db
def test_no_conflict_when_finishing_on_boundary(calendar: Calendar) -> None:
    """early_finish == finish_date is on time (inclusive boundary, strict >)."""
    program, _a, _b, _a1, b1, sprint, _dep = _scenario(calendar)
    # First pass to learn the program-true finish, then move the sprint boundary to it.
    _run_program_schedule(str(program.pk))
    b1.refresh_from_db()
    Sprint.objects.filter(pk=sprint.pk).update(finish_date=b1.early_finish)
    # Clear the conflict the first pass created so we observe the second pass cleanly.
    CrossProjectSlipConflict.objects.all().delete()

    _run_program_schedule(str(program.pk))

    assert not CrossProjectSlipConflict.objects.filter(
        resolution=SlipConflictResolution.UNRESOLVED
    ).exists()


@pytest.mark.django_db
def test_no_conflict_for_sprint_pending_task(calendar: Calendar) -> None:
    """A mid-sprint injection the team hasn't committed to does not raise a conflict."""
    program, _a, _b, _a1, _b1, _sprint, _dep = _scenario(calendar, sprint_pending=True)

    _run_program_schedule(str(program.pk))

    assert CrossProjectSlipConflict.objects.count() == 0


@pytest.mark.django_db
def test_no_conflict_for_planned_sprint(calendar: Calendar) -> None:
    program, _a, _b, _a1, _b1, _sprint, _dep = _scenario(calendar, sprint_state=SprintState.PLANNED)

    _run_program_schedule(str(program.pk))

    assert CrossProjectSlipConflict.objects.count() == 0


@pytest.mark.django_db
def test_attribution_is_one_row_per_sprint_task(calendar: Calendar) -> None:
    """Two cross edges into the same task produce exactly one conflict row."""
    program, proj_a, _b, _a1, b1, sprint, _dep = _scenario(calendar)
    a2 = Task.objects.create(project=proj_a, name="Audit", duration=15)
    Dependency.objects.create(
        predecessor=a2, successor=b1, dep_type="FS", lag=0, accepted_at=timezone.now()
    )

    _run_program_schedule(str(program.pk))

    assert CrossProjectSlipConflict.objects.filter(sprint=sprint, task=b1).count() == 1


@pytest.mark.django_db
def test_conflict_auto_resolves_when_slip_disappears(calendar: Calendar) -> None:
    program, _a, _b, _a1, b1, sprint, dep = _scenario(calendar)
    _run_program_schedule(str(program.pk))
    assert CrossProjectSlipConflict.objects.get(sprint=sprint, task=b1).is_open

    # Remove the cross edge — B1 no longer slips. The next pass auto-resolves the row.
    dep.soft_delete()
    _run_program_schedule(str(program.pk))

    conflict = CrossProjectSlipConflict.objects.get(sprint=sprint, task=b1)
    assert conflict.resolution == SlipConflictResolution.AUTO_RESOLVED
    assert conflict.resolved_at is not None
    assert conflict.is_open is False


@pytest.mark.django_db
def test_reslip_after_acknowledgment_reopens(calendar: Calendar) -> None:
    program, _a, _b, a1, b1, sprint, _dep = _scenario(calendar, upstream_duration=20)
    _run_program_schedule(str(program.pk))
    conflict = CrossProjectSlipConflict.objects.get(sprint=sprint, task=b1)

    # Acknowledge it.
    ack_user = User.objects.create_user(username="sm", password="pw")
    CrossProjectSlipConflict.objects.filter(pk=conflict.pk).update(
        acknowledged_by=ack_user, acknowledged_at=timezone.now()
    )

    # The upstream task slips further — push B1 even later.
    Task.objects.filter(pk=a1.pk).update(duration=40)
    _run_program_schedule(str(program.pk))

    conflict.refresh_from_db()
    assert conflict.re_slip_count == 1
    assert conflict.acknowledged_at is None  # badge re-lights
    assert conflict.is_open is True


@pytest.mark.django_db
def test_acknowledge_requires_scope_manager(calendar: Calendar) -> None:
    program, _a, proj_b, _a1, b1, sprint, _dep = _scenario(calendar)
    _run_program_schedule(str(program.pk))
    conflict = CrossProjectSlipConflict.objects.get(sprint=sprint, task=b1)

    member = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=proj_b, user=member, role=Role.MEMBER)
    admin = User.objects.create_user(username="admin", password="pw")
    ProjectMembership.objects.create(project=proj_b, user=admin, role=Role.ADMIN)

    url = f"/api/v1/slip-conflicts/{conflict.pk}/acknowledge/"

    member_client = APIClient()
    member_client.force_authenticate(user=member)
    assert member_client.post(url).status_code == 403

    admin_client = APIClient()
    admin_client.force_authenticate(user=admin)
    resp = admin_client.post(url)
    assert resp.status_code == 200, resp.data
    conflict.refresh_from_db()
    assert conflict.acknowledged_by_id == admin.pk
    assert conflict.acknowledged_at is not None

    # Re-acknowledging an already-acknowledged-then-resolved row 400s once resolved.
    CrossProjectSlipConflict.objects.filter(pk=conflict.pk).update(
        resolution=SlipConflictResolution.AUTO_RESOLVED
    )
    assert admin_client.post(url).status_code == 400


@pytest.mark.django_db
def test_conflict_list_scoped_to_member_projects(calendar: Calendar) -> None:
    program, _a, proj_b, _a1, b1, sprint, _dep = _scenario(calendar)
    _run_program_schedule(str(program.pk))
    conflict = CrossProjectSlipConflict.objects.get(sprint=sprint, task=b1)

    member = User.objects.create_user(username="b-member", password="pw")
    ProjectMembership.objects.create(project=proj_b, user=member, role=Role.MEMBER)
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    outsider = User.objects.create_user(username="outsider", password="pw")

    member_client = APIClient()
    member_client.force_authenticate(user=member)
    resp = member_client.get(f"/api/v1/slip-conflicts/?program={program.pk}")
    assert resp.status_code == 200
    ids = {row["id"] for row in resp.data["results"]}
    assert str(conflict.pk) in ids

    outsider_client = APIClient()
    outsider_client.force_authenticate(user=outsider)
    resp = outsider_client.get("/api/v1/slip-conflicts/")
    assert resp.status_code == 200
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_unmodeled_dependency_excludes_accepted_cross_predecessor(calendar: Calendar) -> None:
    """ADR-0106 integration: an accepted cross-project predecessor is modeled by the
    program pass and no longer counts as unmodeled; a pending one still does."""
    program = Program.objects.create(name="GA Launch")
    proj_a = Project.objects.create(
        name="Security", start_date=START, calendar=calendar, program=program
    )
    proj_b = Project.objects.create(
        name="Marketing", start_date=START, calendar=calendar, program=program
    )
    upstream = Task.objects.create(project=proj_a, name="Sign-off", duration=5)
    milestone = Task.objects.create(project=proj_b, name="GA gate", duration=0, is_milestone=True)
    dep = Dependency.objects.create(
        predecessor=upstream, successor=milestone, dep_type="FS", lag=0, accepted_at=timezone.now()
    )

    # Accepted → modeled → not flagged.
    assert _unmodeled_predecessors(milestone) == []

    # Pending → inert → still unmodeled.
    Dependency.objects.filter(pk=dep.pk).update(pending_acceptance=True)
    assert str(upstream.pk) in _unmodeled_predecessors(milestone)
