"""Inheritable near-critical float threshold (ADR-1381 amendment, #4891).

`near_critical_threshold_days` is the number of WORKING days of total float at or below
which a task is "near-critical" on the driving-chain payload (float 0 is critical). It
is inheritable Workspace → Program → Project with a non-null Workspace root of 10, and
has NO enforcement seam — freely overridable at every scope (OSS), like the estimation
scale (ADR-0510). It only shades a display band; it never moves a date.

Covers: defaults, resolver precedence + source (no HTTP), the float_band classifier, the
serializer effective/inherited surface on Project and Program, the Workspace raw field,
the 1..260 range, and the Scheduler+-writable / Member-blocked gate.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Program, Project
from trueppm_api.apps.projects.near_critical_threshold import (
    float_band,
    resolve_effective_near_critical_threshold,
    resolve_inherited_near_critical_threshold,
    resolve_near_critical_threshold_source,
)
from trueppm_api.apps.workspace.models import Workspace

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


def _project(calendar: Calendar, **kw: object) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar, **kw)


def _member_client(project: Project, role: int, username: str = "u") -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _set_workspace(value: int) -> Workspace:
    ws = Workspace.load()
    ws.near_critical_threshold_days = value
    ws.save()
    return ws


# --- defaults ---------------------------------------------------------------


@pytest.mark.django_db
def test_workspace_defaults_to_ten_working_days() -> None:
    """Two weeks: at 2 days a task is effectively an emergency, so amber starts earlier."""
    assert Workspace.load().near_critical_threshold_days == 10


@pytest.mark.django_db
def test_program_and_project_default_to_inherit(calendar: Calendar) -> None:
    prog = Program.objects.create(name="Prog")
    p = _project(calendar, program=prog)
    assert prog.near_critical_threshold_days is None
    assert p.near_critical_threshold_days is None


# --- resolver precedence + source (no HTTP) ---------------------------------


@pytest.mark.django_db
def test_resolver_project_override_wins(calendar: Calendar) -> None:
    _set_workspace(10)
    prog = Program.objects.create(name="Prog", near_critical_threshold_days=15)
    p = _project(calendar, program=prog, near_critical_threshold_days=3)

    assert resolve_effective_near_critical_threshold(p) == 3
    assert resolve_near_critical_threshold_source(p) == "project"
    # inherited skips the project's own override → the program tier.
    assert resolve_inherited_near_critical_threshold(p) == 15


@pytest.mark.django_db
def test_resolver_program_override_inherited_by_project(calendar: Calendar) -> None:
    _set_workspace(10)
    prog = Program.objects.create(name="Prog", near_critical_threshold_days=20)
    p = _project(calendar, program=prog)

    assert resolve_effective_near_critical_threshold(p) == 20
    assert resolve_near_critical_threshold_source(p) == "program"
    assert resolve_inherited_near_critical_threshold(p) == 20


@pytest.mark.django_db
def test_resolver_falls_through_to_workspace(calendar: Calendar) -> None:
    _set_workspace(7)
    prog = Program.objects.create(name="Prog")
    p = _project(calendar, program=prog)

    assert resolve_effective_near_critical_threshold(prog) == 7
    assert resolve_effective_near_critical_threshold(p) == 7
    assert resolve_near_critical_threshold_source(p) == "workspace"


@pytest.mark.django_db
def test_resolver_standalone_project_uses_workspace(calendar: Calendar) -> None:
    _set_workspace(12)
    p = _project(calendar)
    assert resolve_effective_near_critical_threshold(p) == 12
    assert resolve_near_critical_threshold_source(p) == "workspace"


@pytest.mark.django_db
def test_resolver_program_source_and_inherited(calendar: Calendar) -> None:
    _set_workspace(10)
    prog = Program.objects.create(name="Prog", near_critical_threshold_days=5)

    assert resolve_effective_near_critical_threshold(prog) == 5
    assert resolve_near_critical_threshold_source(prog) == "program"
    assert resolve_inherited_near_critical_threshold(prog) == 10


# --- the band classifier ----------------------------------------------------


@pytest.mark.parametrize(
    ("float_days", "threshold", "band"),
    [
        (0, 10, "critical"),
        (-2, 10, "critical"),  # already late is still critical, never "ample"
        (1, 10, "near_critical"),
        (10, 10, "near_critical"),  # the threshold itself is inside the band
        (11, 10, "ample"),
        (3, 2, "ample"),
    ],
)
def test_float_band(float_days: int, threshold: int, band: str) -> None:
    assert float_band(float_days, threshold) == band


# --- serializer surface ------------------------------------------------------


@pytest.mark.django_db
def test_project_serializer_exposes_effective_and_inherited(calendar: Calendar) -> None:
    _set_workspace(10)
    prog = Program.objects.create(name="Prog", near_critical_threshold_days=20)
    p = _project(calendar, program=prog)
    client = _member_client(p, Role.ADMIN)

    r = client.get(f"/api/v1/projects/{p.pk}/")
    assert r.status_code == 200
    assert r.data["near_critical_threshold_days"] is None  # no own override
    assert r.data["effective_near_critical_threshold_days"] == 20  # program tier
    assert r.data["inherited_near_critical_threshold_days"] == 20


@pytest.mark.django_db
def test_program_serializer_exposes_effective_and_inherited() -> None:
    _set_workspace(8)
    prog = Program.objects.create(name="Prog")
    user = User.objects.create_user(username="pm", password="pw")
    ProgramMembership.objects.create(program=prog, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)

    r = client.get(f"/api/v1/programs/{prog.pk}/")
    assert r.status_code == 200
    assert r.data["near_critical_threshold_days"] is None
    assert r.data["effective_near_critical_threshold_days"] == 8  # workspace
    assert r.data["inherited_near_critical_threshold_days"] == 8


@pytest.mark.django_db
def test_workspace_serializer_exposes_raw_value(project: Project) -> None:
    _set_workspace(14)
    user = User.objects.create_user(username="pm", password="pw", is_staff=True)
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)

    r = client.get("/api/v1/workspace/")
    assert r.status_code == 200
    assert r.data["near_critical_threshold_days"] == 14


# --- write permission + range ------------------------------------------------


@pytest.mark.django_db
def test_scheduler_can_set_project_threshold(project: Project) -> None:
    """A Scheduler may override it — it is in _SCHEDULER_WRITABLE_FIELDS."""
    client = _member_client(project, Role.SCHEDULER)
    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"near_critical_threshold_days": 5},
        format="json",
    )
    assert r.status_code == 200
    project.refresh_from_db()
    assert project.near_critical_threshold_days == 5


@pytest.mark.django_db
def test_scheduler_can_clear_override_back_to_inherit(project: Project) -> None:
    Project.objects.filter(pk=project.pk).update(near_critical_threshold_days=5)
    client = _member_client(project, Role.SCHEDULER)
    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"near_critical_threshold_days": None},
        format="json",
    )
    assert r.status_code == 200
    project.refresh_from_db()
    assert project.near_critical_threshold_days is None


@pytest.mark.django_db
def test_member_cannot_set_project_threshold(project: Project) -> None:
    client = _member_client(project, Role.MEMBER)
    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"near_critical_threshold_days": 5},
        format="json",
    )
    assert r.status_code in (400, 403)
    project.refresh_from_db()
    assert project.near_critical_threshold_days is None


@pytest.mark.django_db
@pytest.mark.parametrize("bad", [0, -1, 261])
def test_out_of_range_value_is_refused(project: Project, bad: int) -> None:
    client = _member_client(project, Role.SCHEDULER)
    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"near_critical_threshold_days": bad},
        format="json",
    )
    assert r.status_code == 400
    project.refresh_from_db()
    assert project.near_critical_threshold_days is None


@pytest.mark.django_db
@pytest.mark.parametrize("edge", [1, 260])
def test_range_boundaries_are_accepted(project: Project, edge: int) -> None:
    client = _member_client(project, Role.SCHEDULER)
    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"near_critical_threshold_days": edge},
        format="json",
    )
    assert r.status_code == 200


# --- program + workspace scope: write gate and range --------------------------


def _program_client(prog: Program, role: int) -> APIClient:
    user = User.objects.create_user(username=f"pm{role}", password="pw")
    ProgramMembership.objects.create(program=prog, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.mark.django_db
def test_program_admin_can_set_and_clear_override() -> None:
    prog = Program.objects.create(name="Prog")
    client = _program_client(prog, Role.ADMIN)
    r = client.patch(
        f"/api/v1/programs/{prog.pk}/", {"near_critical_threshold_days": 15}, format="json"
    )
    assert r.status_code == 200
    prog.refresh_from_db()
    assert prog.near_critical_threshold_days == 15
    r = client.patch(
        f"/api/v1/programs/{prog.pk}/", {"near_critical_threshold_days": None}, format="json"
    )
    assert r.status_code == 200
    prog.refresh_from_db()
    assert prog.near_critical_threshold_days is None


@pytest.mark.django_db
def test_program_member_cannot_set_override() -> None:
    """Program writes are Program-Admin only — unlike the project, Scheduler does not apply."""
    prog = Program.objects.create(name="Prog")
    client = _program_client(prog, Role.MEMBER)
    r = client.patch(
        f"/api/v1/programs/{prog.pk}/", {"near_critical_threshold_days": 15}, format="json"
    )
    assert r.status_code in (400, 403)
    prog.refresh_from_db()
    assert prog.near_critical_threshold_days is None


@pytest.mark.django_db
@pytest.mark.parametrize("bad", [0, -1, 261])
def test_program_out_of_range_is_refused(bad: int) -> None:
    prog = Program.objects.create(name="Prog")
    client = _program_client(prog, Role.ADMIN)
    r = client.patch(
        f"/api/v1/programs/{prog.pk}/", {"near_critical_threshold_days": bad}, format="json"
    )
    assert r.status_code == 400
    prog.refresh_from_db()
    assert prog.near_critical_threshold_days is None


def _workspace_client(*, staff: bool) -> APIClient:
    user = User.objects.create_user(username=f"ws{staff}", password="pw", is_superuser=staff)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.mark.django_db
def test_workspace_admin_can_set_root_value() -> None:
    r = _workspace_client(staff=True).patch(
        "/api/v1/workspace/", {"near_critical_threshold_days": 20}, format="json"
    )
    assert r.status_code == 200
    assert Workspace.load().near_critical_threshold_days == 20


@pytest.mark.django_db
def test_non_admin_cannot_set_workspace_root_value() -> None:
    r = _workspace_client(staff=False).patch(
        "/api/v1/workspace/", {"near_critical_threshold_days": 20}, format="json"
    )
    assert r.status_code in (400, 403)
    assert Workspace.load().near_critical_threshold_days == 10  # unchanged default


@pytest.mark.django_db
@pytest.mark.parametrize("bad", [0, 261, None])
def test_workspace_out_of_range_or_null_is_refused(bad: int | None) -> None:
    """The root is non-null: there is nothing above it to inherit from."""
    r = _workspace_client(staff=True).patch(
        "/api/v1/workspace/", {"near_critical_threshold_days": bad}, format="json"
    )
    assert r.status_code == 400
    assert Workspace.load().near_critical_threshold_days == 10
