"""Tests for the seed_ga_launch_program management command (issue #1151).

These assert the spec's guarantees on the *outcome* (models), not on migration
internals: the program + four workstream projects exist, there are accepted
cross-project dependency edges, the real program-scoped CPM pass produces a
program-true cross-project critical path (D5 lands after both A5 and C5, with
CPM outputs populated by the scheduler — never hard-coded), shared resources
over-allocate in overlapping windows, a closed sprint yields a real velocity +
burndown, and the 5-role RBAC matrix is present.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db.models import F

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    BoardColumnConfig,
    Dependency,
    Program,
    Project,
    Sprint,
    SprintBurnSnapshot,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.program_schedule import program_has_accepted_cross_edges
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()

PROGRAM_NAME = "1.0 GA Launch"


def _program() -> Program:
    return Program.objects.get(name=PROGRAM_NAME)


def _task(program: Program, name: str) -> Task:
    return Task.objects.get(project__program=program, name=name)


@pytest.mark.django_db
def test_creates_program_and_four_sample_projects() -> None:
    call_command("seed_ga_launch_program")
    program = _program()
    projects = Project.objects.filter(program=program)
    assert projects.count() == 4
    assert all(p.is_sample for p in projects)
    assert program.code == "GALA"


@pytest.mark.django_db
def test_is_idempotent() -> None:
    call_command("seed_ga_launch_program")
    call_command("seed_ga_launch_program")
    assert Program.objects.filter(name=PROGRAM_NAME).count() == 1
    program = _program()
    assert Project.objects.filter(program=program).count() == 4
    # Tasks are not duplicated: 20 workstream tasks (5 per project).
    assert Task.objects.filter(project__program=program, is_deleted=False).count() == 20
    # Persona resources are not duplicated on reload.
    assert Resource.objects.filter(email__endswith="@trueppm.demo").count() == 7


@pytest.mark.django_db
def test_seven_personas_and_linked_resources() -> None:
    call_command("seed_ga_launch_program")
    usernames = {"dana", "malcolm", "janus", "bob", "jane", "lena", "sam"}
    assert set(User.objects.filter(username__in=usernames).values_list("username", flat=True)) == (
        usernames
    )
    resources = Resource.objects.filter(email__endswith="@trueppm.demo")
    assert resources.count() == 7
    # Every persona resource is linked to its user (spec §5).
    assert all(r.user is not None for r in resources)


@pytest.mark.django_db
def test_accepted_cross_project_edges_exist() -> None:
    call_command("seed_ga_launch_program")
    program = _program()
    cross = Dependency.objects.filter(
        is_deleted=False,
        pending_acceptance=False,
        predecessor__project__program=program,
        successor__project__program=program,
    ).exclude(predecessor__project_id=F("successor__project_id"))
    # B3←C5, D5←A5, D5←C5 (spec §6).
    assert cross.count() == 3
    # The escalation predicate must see them, or the program pass never runs.
    assert program_has_accepted_cross_edges(program.pk) is True


@pytest.mark.django_db
def test_cpm_produces_program_true_cross_project_critical_path() -> None:
    """The program-scoped CPM must gate the go-live behind its upstream milestones
    and mark a cross-project edge critical — computed by the scheduler, not seeded.

    Under the real durations the program's terminal work is SOC 2 audit-readiness
    (``B5``), because evidence collection (``B3``) waits on Security sign-off
    (``C5``) via the cross-project edge and then feeds the review/audit tail. So
    the program-true critical path runs *across* projects through ``C5 → B3``:
    Security is critical, and it makes SOC 2's downstream tasks critical too. The
    go-live milestone (``D5``) is correctly gated behind both ``A5`` and ``C5`` but
    carries float (it finishes before the SOC 2 tail), so it is *not* asserted
    critical — that would be the SNET-faked path the issue rejected.
    """
    call_command("seed_ga_launch_program")
    program = _program()

    a5 = _task(program, "Platform GA-ready")
    c5 = _task(program, "Security sign-off")
    b3 = _task(program, "Evidence collection")
    d5 = _task(program, "GA announcement go-live")

    # CPM outputs were populated by the program pass (proof the scheduler ran).
    assert a5.early_finish is not None
    assert c5.early_finish is not None
    assert d5.early_start is not None

    # Program-true across the boundary: go-live cannot start before either gate.
    assert d5.early_start >= a5.early_finish
    assert d5.early_start >= c5.early_finish

    # The cross-project edge C5 → B3 sits on the program-true critical path: the
    # Security sign-off and the SOC 2 evidence it gates are both critical against
    # the *program*. B3 also cannot start until C5 finishes — the honest, computed
    # cross-project constraint, not a hard-coded SNET floor.
    assert c5.is_critical is True
    assert b3.is_critical is True
    assert b3.early_start >= c5.early_finish


@pytest.mark.django_db
def test_seed_sets_no_cpm_outputs_itself() -> None:
    """Guard against a regression that hard-codes CPM fields in the seed: with the
    program pass patched out, every task's CPM outputs stay null (spec §2/AC#5)."""
    from unittest.mock import patch

    with patch("trueppm_api.apps.scheduling.tasks._run_program_schedule"):
        call_command("seed_ga_launch_program")

    program = _program()
    tasks = Task.objects.filter(project__program=program, is_deleted=False)
    assert tasks.exists()
    for t in tasks:
        assert t.early_start is None
        assert t.early_finish is None
        assert t.total_float is None
        assert t.is_critical is None


def _peak_allocation(resource: Resource) -> Decimal:
    """Peak summed allocation for a resource across its scheduled task windows.

    Sweeps every working-day between the earliest start and latest finish of the
    resource's non-milestone assignments (using CPM-computed early dates) and
    returns the maximum concurrent sum of units — the number that exceeds
    ``max_units`` when the resource is over-allocated in an overlapping window.
    """
    rows = [
        (tr.task.early_start, tr.task.early_finish, tr.units)
        for tr in TaskResource.objects.filter(resource=resource).select_related("task")
        if tr.task.early_start is not None
        and tr.task.early_finish is not None
        and not tr.task.is_milestone
    ]
    if not rows:
        return Decimal("0")
    earliest = min(start for start, _f, _u in rows)
    latest = max(finish for _s, finish, _u in rows)
    peak = Decimal("0")
    day = earliest
    while day < latest:
        # A task occupies [early_start, early_finish); sum units of the overlaps.
        concurrent = sum(
            (units for start, finish, units in rows if start <= day < finish),
            Decimal("0"),
        )
        peak = max(peak, concurrent)
        day += timedelta(days=1)
    return peak


@pytest.mark.django_db
def test_shared_resources_over_allocate_in_overlapping_window() -> None:
    call_command("seed_ga_launch_program")

    malcolm = Resource.objects.get(email="malcolm@trueppm.demo")
    janus = Resource.objects.get(email="janus@trueppm.demo")

    # Both are 100%-capacity people (max_units 1.0) pulled across workstreams into
    # concurrent windows (spec §5 / AC#4).
    assert malcolm.max_units == Decimal("1.0")
    assert janus.max_units == Decimal("1.0")
    assert _peak_allocation(malcolm) > Decimal("1.0")
    assert _peak_allocation(janus) > Decimal("1.0")


@pytest.mark.django_db
def test_closed_sprint_has_velocity_and_burndown() -> None:
    call_command("seed_ga_launch_program")
    program = _program()

    completed = Sprint.objects.filter(project__program=program, state=SprintState.COMPLETED)
    assert completed.count() == 1
    s1 = completed.get()
    # A real, non-zero velocity is computable from a closed sprint that counts.
    assert s1.completed_points and s1.completed_points > 0
    assert s1.exclude_from_velocity is False

    snapshots = SprintBurnSnapshot.objects.filter(sprint=s1)
    assert snapshots.count() >= 7
    assert snapshots.filter(scope_change_points__gt=0).exists()

    # An active sprint bound to the go-live milestone also exists.
    active = Sprint.objects.filter(project__program=program, state=SprintState.ACTIVE)
    assert active.count() == 1
    assert active.get().target_milestone == _task(program, "GA announcement go-live")


@pytest.mark.django_db
def test_rbac_matrix_exercises_all_five_roles() -> None:
    call_command("seed_ga_launch_program")
    program = _program()

    project_roles = set(
        ProjectMembership.objects.filter(project__program=program).values_list("role", flat=True)
    )
    assert project_roles == {
        Role.VIEWER,
        Role.MEMBER,
        Role.SCHEDULER,
        Role.ADMIN,
        Role.OWNER,
    }
    # Dana owns the program; the four workstream leads are program members.
    dana = User.objects.get(username="dana")
    assert ProgramMembership.objects.get(program=program, user=dana).role == Role.OWNER
    assert ProgramMembership.objects.filter(program=program, role=Role.MEMBER).count() == 4


@pytest.mark.django_db
def test_security_project_has_kanban_board_config() -> None:
    call_command("seed_ga_launch_program")
    program = _program()
    security = Project.objects.get(program=program, name="Security Pen-Test & Remediation")
    config = BoardColumnConfig.objects.get(project=security)
    statuses = {c["status"] for c in config.columns}
    assert "IN_PROGRESS" in statuses
    # The In-progress lane carries a WIP limit (the remediation Kanban).
    in_progress = next(c for c in config.columns if c["status"] == "IN_PROGRESS")
    assert in_progress["wip_limit"] == 3


@pytest.mark.django_db
def test_calendar_exception_seeded() -> None:
    call_command("seed_ga_launch_program")
    program = _program()
    project = Project.objects.filter(program=program).first()
    assert project is not None
    assert project.calendar is not None
    assert project.calendar.exceptions.filter(exc_start=date(2026, 9, 7)).exists()


@pytest.mark.django_db
def test_personas_loginable_only_with_flag(settings: pytest.FixtureRequest) -> None:
    settings.DEBUG = True  # type: ignore[attr-defined]
    call_command("seed_ga_launch_program", "--with-personas")
    assert User.objects.get(username="dana").has_usable_password() is True


@pytest.mark.django_db
def test_personas_not_loginable_without_flag() -> None:
    call_command("seed_ga_launch_program")
    assert User.objects.get(username="dana").has_usable_password() is False
