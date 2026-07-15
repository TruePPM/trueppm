"""Project → Program → Workspace working-calendar inheritance (ADR-0441, #1987).

Covers:
- the computed-on-read resolver precedence (project ?? program ?? workspace ?? system);
- the ``calendar_source`` breadcrumb;
- the ENFORCE enterprise seam (no-op in OSS, locks when a provider is registered);
- that CPM schedules against the *resolved* base calendar (an inherited holiday shifts
  the finish; overlays still compose on top of an inherited base);
- the serializer's ``effective_calendar`` / ``inherited_calendar`` / ``calendar_source``
  read fields and the workspace ``calendar`` / ``calendar_override_policy`` round-trip;
- the recompute fan-out when a program/workspace calendar is reassigned or its definition
  is edited (every inheriting project is rescheduled; overriding projects are not).
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.calendar_settings import (
    calendar_enforcement_active,
    register_calendar_enforcement_provider,
    resolve_calendar_source,
    resolve_effective_base_calendar,
    resolve_inherited_base_calendar,
)
from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Program,
    Project,
    ProjectCalendarLayer,
    Task,
)
from trueppm_api.apps.scheduling.models import ScheduleRequest
from trueppm_api.apps.workspace.models import TermOverridePolicy, Workspace

User = get_user_model()

# Monday, so a standard Mon-Fri calendar starts work immediately.
START = date(2026, 3, 2)


@pytest.fixture
def ws_calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Workspace Std", working_days=31)


@pytest.fixture
def program_calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Program Cal", working_days=31)


@pytest.fixture
def project_calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Project Cal", working_days=31)


def _project(**kw: object) -> Project:
    kw.setdefault("name", "P")
    kw.setdefault("start_date", START)
    return Project.objects.create(**kw)


# ---------------------------------------------------------------------------
# Resolver precedence
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_precedence_project_over_program_over_workspace_over_system(
    ws_calendar: Calendar, program_calendar: Calendar, project_calendar: Calendar
) -> None:
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.save()
    prog = Program.objects.create(name="Prog", calendar=program_calendar)
    p = _project(program=prog, calendar=project_calendar)

    # Project override wins.
    assert resolve_effective_base_calendar(p) == project_calendar
    # Cleared → falls back to the program calendar.
    p.calendar = None
    p.save()
    assert resolve_effective_base_calendar(p) == program_calendar
    # Program cleared too → falls back to the workspace calendar.
    prog.calendar = None
    prog.save()
    p.program.refresh_from_db()
    assert resolve_effective_base_calendar(p) == ws_calendar
    # Workspace cleared too → system default (None; CPM uses Mon-Fri/8h/UTC).
    ws.calendar = None
    ws.save()
    assert resolve_effective_base_calendar(p) is None


@pytest.mark.django_db
def test_standalone_project_inherits_workspace(ws_calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.save()
    p = _project()  # no program, NULL override
    assert resolve_effective_base_calendar(p) == ws_calendar


@pytest.mark.django_db
def test_program_inherits_workspace(ws_calendar: Calendar, program_calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.save()
    prog = Program.objects.create(name="Prog")  # NULL override → inherit workspace
    assert resolve_effective_base_calendar(prog) == ws_calendar
    prog.calendar = program_calendar
    prog.save()
    assert resolve_effective_base_calendar(prog) == program_calendar


@pytest.mark.django_db
def test_calendar_source_breadcrumb(
    ws_calendar: Calendar, program_calendar: Calendar, project_calendar: Calendar
) -> None:
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.save()
    prog = Program.objects.create(name="Prog", calendar=program_calendar)
    p = _project(program=prog, calendar=project_calendar)
    assert resolve_calendar_source(p) == "project"
    p.calendar = None
    p.save()
    assert resolve_calendar_source(p) == "program"
    prog.calendar = None
    prog.save()
    p.program.refresh_from_db()
    assert resolve_calendar_source(p) == "workspace"
    ws.calendar = None
    ws.save()
    assert resolve_calendar_source(p) == "system_default"


@pytest.mark.django_db
def test_inherited_skips_own_value(
    ws_calendar: Calendar, program_calendar: Calendar, project_calendar: Calendar
) -> None:
    """inherited_ is what the object WOULD resolve to with its own override cleared."""
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.save()
    prog = Program.objects.create(name="Prog", calendar=program_calendar)
    p = _project(program=prog, calendar=project_calendar)
    # Own value is project_calendar, but inherited skips it → program calendar.
    assert resolve_inherited_base_calendar(p) == program_calendar
    # A program's inherited value is always the workspace calendar (its only parent).
    assert resolve_inherited_base_calendar(prog) == ws_calendar


# ---------------------------------------------------------------------------
# Enterprise ENFORCE seam
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_enforce_is_noop_in_oss(ws_calendar: Calendar, project_calendar: Calendar) -> None:
    """OSS registers no provider → ENFORCE degrades to SUGGEST: the project override wins."""
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.calendar_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    p = _project(calendar=project_calendar)
    assert calendar_enforcement_active() is False
    assert resolve_effective_base_calendar(p) == project_calendar


@pytest.mark.django_db
def test_enforce_locks_when_provider_active(
    ws_calendar: Calendar, project_calendar: Calendar
) -> None:
    """With an enterprise provider registered, ENFORCE locks to the workspace calendar."""
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.calendar_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    p = _project(calendar=project_calendar)
    register_calendar_enforcement_provider(lambda: True)
    try:
        assert calendar_enforcement_active() is True
        assert resolve_effective_base_calendar(p) == ws_calendar
        assert resolve_calendar_source(p) == "workspace"
    finally:
        register_calendar_enforcement_provider(None)


@pytest.mark.django_db
def test_inherit_policy_locks_to_workspace(
    ws_calendar: Calendar, project_calendar: Calendar
) -> None:
    """INHERIT hides the override affordance and always resolves to the workspace value."""
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.calendar_override_policy = TermOverridePolicy.INHERIT
    ws.save()
    p = _project(calendar=project_calendar)
    assert resolve_effective_base_calendar(p) == ws_calendar


# ---------------------------------------------------------------------------
# CPM schedules against the resolved base calendar
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_cpm_inherits_program_calendar_holiday(program_calendar: Calendar) -> None:
    """A project with no own calendar inherits its program's — an inherited holiday
    on Wednesday pushes a 5-day task's finish from Fri to the following Mon."""
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    CalendarException.objects.create(
        calendar=program_calendar,
        exc_start=date(2026, 3, 4),
        exc_end=date(2026, 3, 4),
        description="Program holiday",
    )
    prog = Program.objects.create(name="Prog", calendar=program_calendar)
    project = _project(program=prog, calendar=None)  # inherits the program calendar
    task = Task.objects.create(project=project, name="Build", duration=5)

    _run_schedule(str(project.pk), tracker=None)

    task.refresh_from_db()
    assert task.early_finish == date(2026, 3, 9)


@pytest.mark.django_db
def test_cpm_inherits_workspace_calendar_working_days(ws_calendar: Calendar) -> None:
    """A project with no own/program calendar composes the workspace calendar's mask."""
    from trueppm_api.apps.scheduling.calendars import compose_project_calendar

    ws_calendar.working_days = 0b0001111  # Mon-Thu
    ws_calendar.save()
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.save()
    project = _project()  # no own calendar, no program

    sched = compose_project_calendar(project)
    assert sched.is_working_day(date(2026, 3, 5))  # Thursday — working
    assert not sched.is_working_day(date(2026, 3, 6))  # Friday — dropped by workspace cal


@pytest.mark.django_db
def test_overlays_compose_on_inherited_base(program_calendar: Calendar) -> None:
    """A project's own overlay still ANDs on top of an inherited program base."""
    from trueppm_api.apps.scheduling.calendars import compose_project_calendar

    prog = Program.objects.create(name="Prog", calendar=program_calendar)
    project = _project(program=prog, calendar=None)  # inherits program base (Mon-Fri)
    part_time = Calendar.objects.create(name="Mon-Thu", working_days=0b0001111)
    ProjectCalendarLayer.objects.create(
        project=project, calendar=part_time, role="workspace", sort_order=0
    )

    sched = compose_project_calendar(project)
    assert sched.is_working_day(date(2026, 3, 5))  # Thursday — working in both
    assert not sched.is_working_day(date(2026, 3, 6))  # Friday — dropped by overlay


@pytest.mark.django_db
def test_own_calendar_ignores_program(
    program_calendar: Calendar, project_calendar: Calendar
) -> None:
    """A project that sets its own calendar is unaffected by the program calendar."""
    project_calendar.working_days = 0b0001111  # Mon-Thu
    project_calendar.save()
    prog = Program.objects.create(name="Prog", calendar=program_calendar)  # Mon-Fri
    project = _project(program=prog, calendar=project_calendar)

    assert resolve_effective_base_calendar(project) == project_calendar


# ---------------------------------------------------------------------------
# Serializer read fields
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_serializer_effective_calendar_and_source(
    ws_calendar: Calendar, program_calendar: Calendar
) -> None:
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.save()
    CalendarException.objects.create(
        calendar=program_calendar, exc_start=date(2026, 7, 4), exc_end=date(2026, 7, 4)
    )
    prog = Program.objects.create(name="Prog", calendar=program_calendar)
    project = _project(program=prog, calendar=None)
    user = User.objects.create_user(username="u_eff", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200
    assert resp.data["calendar"] is None
    assert resp.data["calendar_source"] == "program"
    assert resp.data["effective_calendar"]["id"] == str(program_calendar.id)
    assert resp.data["effective_calendar"]["holiday_count"] == 1


@pytest.mark.django_db
def test_project_serializer_system_default_effective_is_null(db: object) -> None:
    project = _project()  # nothing set anywhere
    user = User.objects.create_user(username="u_sys", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200
    assert resp.data["effective_calendar"] is None
    assert resp.data["calendar_source"] == "system_default"


@pytest.mark.django_db
def test_program_serializer_effective_inherited_source(
    ws_calendar: Calendar, program_calendar: Calendar
) -> None:
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.save()
    prog = Program.objects.create(name="Prog", calendar=program_calendar)
    user = User.objects.create_user(username="u_prog", password="pw")
    ProgramMembership.objects.create(program=prog, user=user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.get(f"/api/v1/programs/{prog.pk}/")
    assert resp.status_code == 200
    assert resp.data["calendar_source"] == "program"
    assert resp.data["effective_calendar"]["id"] == str(program_calendar.id)
    # inherited = the workspace value shown if the program override were cleared.
    assert resp.data["inherited_calendar"]["id"] == str(ws_calendar.id)


@pytest.mark.django_db
def test_workspace_serializer_calendar_roundtrip(ws_calendar: Calendar) -> None:
    admin = User.objects.create_user(username="ws_admin_cal", password="pw", is_superuser=True)
    client = APIClient()
    client.force_authenticate(user=admin)

    resp = client.patch(
        "/api/v1/workspace/",
        {"calendar": str(ws_calendar.id), "calendar_override_policy": "inherit"},
        format="json",
    )
    assert resp.status_code == 200
    assert str(resp.data["calendar"]) == str(ws_calendar.id)
    assert resp.data["calendar_override_policy"] == "inherit"
    ws = Workspace.load()
    assert ws.calendar_id == ws_calendar.id


# ---------------------------------------------------------------------------
# RBAC / lock backstop on write
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_calendar_override_blocked_under_active_lock(
    ws_calendar: Calendar, project_calendar: Calendar
) -> None:
    """A direct API write of a project calendar override is 403 under an active lock."""
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.calendar_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    project = _project(calendar=None)
    admin = User.objects.create_user(username="u_lock", password="pw")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=admin)

    register_calendar_enforcement_provider(lambda: True)
    try:
        resp = client.patch(
            f"/api/v1/projects/{project.pk}/",
            {"calendar": str(project_calendar.id)},
            format="json",
        )
        assert resp.status_code == 403
    finally:
        register_calendar_enforcement_provider(None)


@pytest.mark.django_db
def test_member_cannot_set_program_calendar(program_calendar: Calendar) -> None:
    """Setting a program's working calendar is an Admin+ action — a Member is refused."""
    prog = Program.objects.create(name="Prog")
    member = User.objects.create_user(username="prog_member", password="pw")
    ProgramMembership.objects.create(program=prog, user=member, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=member)

    resp = client.patch(
        f"/api/v1/programs/{prog.pk}/", {"calendar": str(program_calendar.id)}, format="json"
    )
    assert resp.status_code == 403
    prog.refresh_from_db()
    assert prog.calendar_id is None


# ---------------------------------------------------------------------------
# Recompute fan-out
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_list_effective_calendar_has_no_n_plus_1(ws_calendar: Calendar) -> None:
    """Listing projects that inherit the workspace calendar issues a flat query count.

    effective_calendar.holiday_count reads the workspace calendar's exceptions; the
    serializer warms that prefetch once (ADR-0441 perf note), so adding more inheriting
    projects must not add a query per row.
    """
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    CalendarException.objects.create(
        calendar=ws_calendar, exc_start=date(2026, 7, 4), exc_end=date(2026, 7, 4)
    )
    ws = Workspace.load()
    ws.calendar = ws_calendar
    ws.save()
    user = User.objects.create_user(username="u_list", password="pw")
    client = APIClient()
    client.force_authenticate(user=user)

    p1 = _project(name="P1")
    ProjectMembership.objects.create(project=p1, user=user, role=Role.MEMBER)
    with CaptureQueriesContext(connection) as one:
        resp = client.get("/api/v1/projects/")
    assert resp.status_code == 200
    assert resp.data["results"][0]["calendar_source"] == "workspace"

    for i in range(2, 5):
        pi = _project(name=f"P{i}")
        ProjectMembership.objects.create(project=pi, user=user, role=Role.MEMBER)
    with CaptureQueriesContext(connection) as many:
        resp = client.get("/api/v1/projects/")
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 4
    # No per-row growth: four inheriting projects cost the same queries as one.
    assert len(many.captured_queries) == len(one.captured_queries)


@pytest.mark.django_db(transaction=True)
def test_program_calendar_reassignment_recomputes_inheriting_only(
    program_calendar: Calendar, project_calendar: Calendar
) -> None:
    """Reassigning a program's calendar recomputes inheriting projects, not overriders."""
    prog = Program.objects.create(name="Prog")
    inheriting = _project(name="Inheriting", program=prog, calendar=None)
    overriding = _project(name="Overriding", program=prog, calendar=project_calendar)
    admin = User.objects.create_user(username="prog_admin", password="pw")
    ProgramMembership.objects.create(program=prog, user=admin, role=Role.ADMIN)
    ScheduleRequest.objects.all().delete()

    client = APIClient()
    client.force_authenticate(user=admin)
    resp = client.patch(
        f"/api/v1/programs/{prog.pk}/", {"calendar": str(program_calendar.id)}, format="json"
    )

    assert resp.status_code == 200
    assert ScheduleRequest.objects.filter(project=inheriting).exists()
    assert not ScheduleRequest.objects.filter(project=overriding).exists()


@pytest.mark.django_db(transaction=True)
def test_workspace_calendar_reassignment_recomputes_inheriting(
    ws_calendar: Calendar, project_calendar: Calendar
) -> None:
    """Reassigning the workspace calendar recomputes projects resolving up to workspace."""
    inheriting = _project(name="Inheriting", calendar=None)
    overriding = _project(name="Overriding", calendar=project_calendar)
    admin = User.objects.create_user(username="ws_admin_fan", password="pw", is_superuser=True)
    ScheduleRequest.objects.all().delete()

    client = APIClient()
    client.force_authenticate(user=admin)
    resp = client.patch("/api/v1/workspace/", {"calendar": str(ws_calendar.id)}, format="json")

    assert resp.status_code == 200
    assert ScheduleRequest.objects.filter(project=inheriting).exists()
    assert not ScheduleRequest.objects.filter(project=overriding).exists()


@pytest.mark.django_db(transaction=True)
def test_editing_program_default_calendar_recomputes_inheriting_project(
    program_calendar: Calendar,
) -> None:
    """Editing a calendar used as a PROGRAM default fans out to inheriting projects.

    Widens ADR-0194's ``_recalc_projects_for_calendar`` beyond direct base/overlay use
    to the inheritance chain (ADR-0441) — a program-default working_days edit must reach
    the projects that resolve up to it.
    """
    prog = Program.objects.create(name="Prog", calendar=program_calendar)
    inheriting = _project(name="Inheriting", program=prog, calendar=None)
    admin = User.objects.create_user(username="orgadmin_cal", password="pw", is_superuser=True)
    ScheduleRequest.objects.filter(project=inheriting).delete()

    client = APIClient()
    client.force_authenticate(user=admin)
    resp = client.patch(
        f"/api/v1/calendars/{program_calendar.id}/", {"working_days": 15}, format="json"
    )

    assert resp.status_code == 200
    assert ScheduleRequest.objects.filter(project=inheriting).exists()
