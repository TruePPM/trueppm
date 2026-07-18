"""Configurable, inheritable estimation scale (ADR-0510, #2027).

`estimation_scale` decides which point picker/labels a client renders for the stored
integer `story_points` — Fibonacci, Linear, or T-shirt. It is inheritable
Workspace → Program → Project (the ADR-0151 nullable-enum shape) with a non-null
Workspace root defaulting to Fibonacci. Unlike the calendar/duration policy it has
NO enforcement seam — it is freely overridable at every scope (OSS). It is
display/input-only: no `story_points` value or server computation reads it.

Covers: model/workspace defaults, resolver precedence + source (no HTTP), the
serializer effective/inherited surface on Project and Program, the Workspace raw
field, and the Scheduler+-writable / Member-blocked permission gate.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.estimation_scale import (
    resolve_effective_estimation_scale,
    resolve_estimation_scale_source,
    resolve_inherited_estimation_scale,
)
from trueppm_api.apps.projects.models import (
    Calendar,
    EstimationScale,
    Program,
    Project,
)
from trueppm_api.apps.workspace.models import Workspace

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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


def _set_workspace_scale(value: str = EstimationScale.FIBONACCI) -> Workspace:
    ws = Workspace.load()
    ws.estimation_scale = value
    ws.save()
    return ws


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_workspace_defaults_to_fibonacci() -> None:
    """A fresh workspace estimates in Fibonacci — reproducing the prior de-facto scale."""
    assert Workspace.load().estimation_scale == EstimationScale.FIBONACCI


@pytest.mark.django_db
def test_program_and_project_override_default_to_inherit(calendar: Calendar) -> None:
    """The Program/Project override fields are NULL (= inherit) until set."""
    prog = Program.objects.create(name="Prog")
    p = _project(calendar, program=prog)
    assert prog.estimation_scale is None
    assert p.estimation_scale is None


# ---------------------------------------------------------------------------
# Resolver precedence + source (no HTTP)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolver_project_override_wins(calendar: Calendar) -> None:
    """A project's own override beats program and workspace."""
    _set_workspace_scale(EstimationScale.FIBONACCI)
    prog = Program.objects.create(name="Prog", estimation_scale=EstimationScale.LINEAR)
    p = _project(calendar, program=prog, estimation_scale=EstimationScale.TSHIRT)

    assert resolve_effective_estimation_scale(p) == EstimationScale.TSHIRT
    assert resolve_estimation_scale_source(p) == "project"
    # inherited skips the project's own override → the program tier (linear).
    assert resolve_inherited_estimation_scale(p) == EstimationScale.LINEAR


@pytest.mark.django_db
def test_resolver_program_override_inherited_by_project(calendar: Calendar) -> None:
    """A project with no override inherits its program's override."""
    _set_workspace_scale(EstimationScale.FIBONACCI)
    prog = Program.objects.create(name="Prog", estimation_scale=EstimationScale.TSHIRT)
    p = _project(calendar, program=prog)

    assert resolve_effective_estimation_scale(p) == EstimationScale.TSHIRT
    assert resolve_estimation_scale_source(p) == "program"
    assert resolve_inherited_estimation_scale(p) == EstimationScale.TSHIRT


@pytest.mark.django_db
def test_resolver_falls_through_to_workspace(calendar: Calendar) -> None:
    """Project + program both unset → the workspace value applies."""
    _set_workspace_scale(EstimationScale.LINEAR)
    prog = Program.objects.create(name="Prog")
    p = _project(calendar, program=prog)

    assert resolve_effective_estimation_scale(prog) == EstimationScale.LINEAR
    assert resolve_effective_estimation_scale(p) == EstimationScale.LINEAR
    assert resolve_estimation_scale_source(p) == "workspace"


@pytest.mark.django_db
def test_resolver_standalone_project_uses_workspace(calendar: Calendar) -> None:
    """A project with no program resolves directly against the workspace."""
    _set_workspace_scale(EstimationScale.TSHIRT)
    p = _project(calendar)
    assert resolve_effective_estimation_scale(p) == EstimationScale.TSHIRT
    assert resolve_estimation_scale_source(p) == "workspace"


@pytest.mark.django_db
def test_resolver_program_source_and_inherited(calendar: Calendar) -> None:
    """A program's own override reports source=program; inherited skips to workspace."""
    _set_workspace_scale(EstimationScale.FIBONACCI)
    prog = Program.objects.create(name="Prog", estimation_scale=EstimationScale.LINEAR)

    assert resolve_effective_estimation_scale(prog) == EstimationScale.LINEAR
    assert resolve_estimation_scale_source(prog) == "program"
    assert resolve_inherited_estimation_scale(prog) == EstimationScale.FIBONACCI


# ---------------------------------------------------------------------------
# Serializer surface
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_serializer_exposes_effective_and_inherited(
    calendar: Calendar,
) -> None:
    """The project payload carries the raw override + resolved effective/inherited scale."""
    _set_workspace_scale(EstimationScale.LINEAR)
    prog = Program.objects.create(name="Prog", estimation_scale=EstimationScale.TSHIRT)
    p = _project(calendar, program=prog)
    client = _member_client(p, Role.ADMIN)

    r = client.get(f"/api/v1/projects/{p.pk}/")
    assert r.status_code == 200
    assert r.data["estimation_scale"] is None  # no own override
    assert r.data["effective_estimation_scale"] == EstimationScale.TSHIRT  # program tier
    assert r.data["inherited_estimation_scale"] == EstimationScale.TSHIRT


@pytest.mark.django_db
def test_program_serializer_exposes_effective_and_inherited(
    calendar: Calendar,
) -> None:
    """The program payload carries the resolved effective/inherited scale."""
    _set_workspace_scale(EstimationScale.LINEAR)
    prog = Program.objects.create(name="Prog")
    # A program admin membership is needed to read the program detail.
    user = User.objects.create_user(username="pm", password="pw")
    from trueppm_api.apps.access.models import ProgramMembership

    ProgramMembership.objects.create(program=prog, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)

    r = client.get(f"/api/v1/programs/{prog.pk}/")
    assert r.status_code == 200
    assert r.data["estimation_scale"] is None
    assert r.data["effective_estimation_scale"] == EstimationScale.LINEAR  # workspace
    assert r.data["inherited_estimation_scale"] == EstimationScale.LINEAR


@pytest.mark.django_db
def test_workspace_serializer_exposes_raw_scale(project: Project) -> None:
    """The workspace settings payload carries the non-null root scale."""
    _set_workspace_scale(EstimationScale.TSHIRT)
    user = User.objects.create_user(username="pm", password="pw", is_staff=True)
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)

    r = client.get("/api/v1/workspace/")
    assert r.status_code == 200
    assert r.data["estimation_scale"] == EstimationScale.TSHIRT


# ---------------------------------------------------------------------------
# Write permission — Scheduler+ writable (PO/team territory), Member blocked
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_scheduler_can_set_project_estimation_scale(project: Project) -> None:
    """A Scheduler may override the scale — it is in _SCHEDULER_WRITABLE_FIELDS."""
    client = _member_client(project, Role.SCHEDULER)
    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"estimation_scale": EstimationScale.TSHIRT},
        format="json",
    )
    assert r.status_code == 200
    project.refresh_from_db()
    assert project.estimation_scale == EstimationScale.TSHIRT


@pytest.mark.django_db
def test_member_cannot_set_project_estimation_scale(project: Project) -> None:
    """A Member is below the Scheduler write gate — the override is rejected."""
    client = _member_client(project, Role.MEMBER)
    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"estimation_scale": EstimationScale.TSHIRT},
        format="json",
    )
    assert r.status_code in (400, 403)
    project.refresh_from_db()
    assert project.estimation_scale is None  # unchanged


@pytest.mark.django_db
def test_setting_scale_never_touches_story_points(project: Project) -> None:
    """Switching the scale is display-only — a stored (possibly off-scale) point is untouched."""
    from trueppm_api.apps.projects.models import Task

    task = Task.objects.create(project=project, name="T", story_points=13)
    client = _member_client(project, Role.SCHEDULER)

    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"estimation_scale": EstimationScale.TSHIRT},
        format="json",
    )
    assert r.status_code == 200
    task.refresh_from_db()
    # 13 is off the T-shirt scale but the integer is preserved verbatim.
    assert task.story_points == 13
