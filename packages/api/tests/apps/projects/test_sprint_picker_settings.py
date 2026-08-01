"""Configurable, inheritable sprint-picker "Ready only" default (ADR-0758, #2670).

`sprint_picker_ready_only_default` decides whether the Sprints page's story
picker starts filtered to Definition-of-Ready stories (ADR-0105) or shows
everything. It is inheritable Workspace -> Program -> Project (the
ADR-0510 nullable-boolean "Shape A" shape) with a non-null Workspace root
defaulting to True. Like `estimation_scale` it has NO enforcement seam — it is
freely overridable at every scope (OSS), and it never hard-gates a commit: the
picker's "Show all" toggle always reveals a not-ready story, and committing one
is never blocked server-side.

Covers: model/workspace defaults, resolver precedence + source (no HTTP), the
serializer effective/inherited surface on Project and Program, the Workspace
raw field, and the Scheduler+-writable / Member-blocked permission gate.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Program, Project
from trueppm_api.apps.projects.sprint_picker_settings import (
    resolve_effective_sprint_picker_ready_only,
    resolve_inherited_sprint_picker_ready_only,
    resolve_sprint_picker_ready_only_source,
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


def _set_workspace_default(value: bool) -> Workspace:
    ws = Workspace.load()
    ws.sprint_picker_ready_only_default = value
    ws.save()
    return ws


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_workspace_defaults_to_ready_only() -> None:
    """A fresh workspace defaults the picker to Ready-only (the safe default)."""
    assert Workspace.load().sprint_picker_ready_only_default is True


@pytest.mark.django_db
def test_program_and_project_override_default_to_inherit(calendar: Calendar) -> None:
    """The Program/Project override fields are NULL (= inherit) until set."""
    prog = Program.objects.create(name="Prog")
    p = _project(calendar, program=prog)
    assert prog.sprint_picker_ready_only_default is None
    assert p.sprint_picker_ready_only_default is None


# ---------------------------------------------------------------------------
# Resolver precedence + source (no HTTP)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolver_project_override_wins(calendar: Calendar) -> None:
    """A project's own override beats program and workspace."""
    _set_workspace_default(True)
    prog = Program.objects.create(name="Prog", sprint_picker_ready_only_default=True)
    p = _project(calendar, program=prog, sprint_picker_ready_only_default=False)

    assert resolve_effective_sprint_picker_ready_only(p) is False
    assert resolve_sprint_picker_ready_only_source(p) == "project"
    # inherited skips the project's own override → the program tier (True).
    assert resolve_inherited_sprint_picker_ready_only(p) is True


@pytest.mark.django_db
def test_resolver_program_override_inherited_by_project(calendar: Calendar) -> None:
    """A project with no override inherits its program's override."""
    _set_workspace_default(True)
    prog = Program.objects.create(name="Prog", sprint_picker_ready_only_default=False)
    p = _project(calendar, program=prog)

    assert resolve_effective_sprint_picker_ready_only(p) is False
    assert resolve_sprint_picker_ready_only_source(p) == "program"
    assert resolve_inherited_sprint_picker_ready_only(p) is False


@pytest.mark.django_db
def test_resolver_falls_through_to_workspace(calendar: Calendar) -> None:
    """Project + program both unset → the workspace value applies."""
    _set_workspace_default(False)
    prog = Program.objects.create(name="Prog")
    p = _project(calendar, program=prog)

    assert resolve_effective_sprint_picker_ready_only(prog) is False
    assert resolve_effective_sprint_picker_ready_only(p) is False
    assert resolve_sprint_picker_ready_only_source(p) == "workspace"


@pytest.mark.django_db
def test_resolver_standalone_project_uses_workspace(calendar: Calendar) -> None:
    """A project with no program resolves directly against the workspace."""
    _set_workspace_default(False)
    p = _project(calendar)
    assert resolve_effective_sprint_picker_ready_only(p) is False
    assert resolve_sprint_picker_ready_only_source(p) == "workspace"


@pytest.mark.django_db
def test_resolver_program_source_and_inherited(calendar: Calendar) -> None:
    """A program's own override reports source=program; inherited skips to workspace."""
    _set_workspace_default(True)
    prog = Program.objects.create(name="Prog", sprint_picker_ready_only_default=False)

    assert resolve_effective_sprint_picker_ready_only(prog) is False
    assert resolve_sprint_picker_ready_only_source(prog) == "program"
    assert resolve_inherited_sprint_picker_ready_only(prog) is True


# ---------------------------------------------------------------------------
# Serializer surface
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_serializer_exposes_effective_and_inherited(
    calendar: Calendar,
) -> None:
    """The project payload carries the raw override + resolved effective/inherited default."""
    _set_workspace_default(False)
    prog = Program.objects.create(name="Prog", sprint_picker_ready_only_default=True)
    p = _project(calendar, program=prog)
    client = _member_client(p, Role.ADMIN)

    r = client.get(f"/api/v1/projects/{p.pk}/")
    assert r.status_code == 200
    assert r.data["sprint_picker_ready_only_default"] is None  # no own override
    assert r.data["effective_sprint_picker_ready_only_default"] is True  # program tier
    assert r.data["inherited_sprint_picker_ready_only_default"] is True


@pytest.mark.django_db
def test_program_serializer_exposes_effective_and_inherited(
    calendar: Calendar,
) -> None:
    """The program payload carries the resolved effective/inherited default."""
    _set_workspace_default(False)
    prog = Program.objects.create(name="Prog")
    user = User.objects.create_user(username="pm", password="pw")
    from trueppm_api.apps.access.models import ProgramMembership

    ProgramMembership.objects.create(program=prog, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)

    r = client.get(f"/api/v1/programs/{prog.pk}/")
    assert r.status_code == 200
    assert r.data["sprint_picker_ready_only_default"] is None
    assert r.data["effective_sprint_picker_ready_only_default"] is False  # workspace
    assert r.data["inherited_sprint_picker_ready_only_default"] is False


@pytest.mark.django_db
def test_workspace_serializer_exposes_raw_default(project: Project) -> None:
    """The workspace settings payload carries the non-null root default."""
    _set_workspace_default(False)
    user = User.objects.create_user(username="pm", password="pw", is_staff=True)
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)

    r = client.get("/api/v1/workspace/")
    assert r.status_code == 200
    assert r.data["sprint_picker_ready_only_default"] is False


# ---------------------------------------------------------------------------
# Write permission — Scheduler+ writable (PO/team territory), Member blocked
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_scheduler_can_set_project_sprint_picker_default(project: Project) -> None:
    """A Scheduler may override the default — it is in _SCHEDULER_WRITABLE_FIELDS."""
    client = _member_client(project, Role.SCHEDULER)
    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"sprint_picker_ready_only_default": False},
        format="json",
    )
    assert r.status_code == 200
    project.refresh_from_db()
    assert project.sprint_picker_ready_only_default is False


@pytest.mark.django_db
def test_member_cannot_set_project_sprint_picker_default(project: Project) -> None:
    """A Member is below the Scheduler write gate — the override is rejected."""
    client = _member_client(project, Role.MEMBER)
    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"sprint_picker_ready_only_default": False},
        format="json",
    )
    assert r.status_code in (400, 403)
    project.refresh_from_db()
    assert project.sprint_picker_ready_only_default is None  # unchanged


@pytest.mark.django_db
def test_setting_default_never_touches_dor_or_commits_tasks(project: Project) -> None:
    """Switching the picker default is display-only — it never mutates a task's dor
    or its sprint membership; the READY gate itself stays advisory (ADR-0105)."""
    from trueppm_api.apps.projects.models import DorState, Task

    task = Task.objects.create(project=project, name="T", dor=DorState.IDEA, sprint=None)
    client = _member_client(project, Role.SCHEDULER)

    r = client.patch(
        f"/api/v1/projects/{project.pk}/",
        {"sprint_picker_ready_only_default": False},
        format="json",
    )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.dor == DorState.IDEA
    assert task.sprint_id is None
