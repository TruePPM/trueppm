"""Workspace → Program → Project sharing-settings inheritance (ADR-0135, #978).

``public_sharing`` (anyone with the link can view) and ``allow_guests`` (external
collaborators) are set at the workspace by default and may be overridden per
program/project. Covers the computed-on-read resolver precedence, the ENFORCE
enterprise seam (no-op in OSS, locks when a provider is registered), the
serializer's ``effective_*`` / ``inherited_*`` read fields, and the ADMIN+ write
gate on the override (program 403, project validate() 400).
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Program, Project
from trueppm_api.apps.projects.sharing_settings import (
    register_sharing_enforcement_provider,
    resolve_effective_sharing,
    resolve_inherited_sharing,
    sharing_enforcement_active,
)
from trueppm_api.apps.workspace.models import TermOverridePolicy, Workspace

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


def _project(calendar: Calendar, **kw: object) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 3, 1), calendar=calendar, **kw)


def _client_for_project(project: Project, role: int, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _client_for_program(program: Program, role: int, username: str) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def enterprise_lock() -> Iterator[None]:
    """Register an active enterprise enforcement provider, clearing on teardown.

    OSS registers no provider, so a test that wants to exercise the ENFORCE lock
    must register one — and MUST clear it afterwards (module-global state) or it
    leaks into every later test in the process.
    """
    register_sharing_enforcement_provider(lambda: True)
    try:
        yield
    finally:
        register_sharing_enforcement_provider(None)


# ---------------------------------------------------------------------------
# Resolver precedence (no HTTP)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_workspace_value_inherited_when_no_overrides(calendar: Calendar) -> None:
    """Program & project overrides NULL → both resolve to the workspace value."""
    ws = Workspace.load()
    ws.public_sharing = True
    ws.allow_guests = False
    ws.save()
    prog = Program.objects.create(name="Prog")  # NULL overrides
    p = _project(calendar, program=prog)  # NULL overrides

    assert resolve_effective_sharing(prog, "public_sharing") is True
    assert resolve_effective_sharing(prog, "allow_guests") is False
    assert resolve_effective_sharing(p, "public_sharing") is True
    assert resolve_effective_sharing(p, "allow_guests") is False


@pytest.mark.django_db
def test_program_override_wins_over_workspace_for_its_projects(calendar: Calendar) -> None:
    """A program override beats the workspace value for the program AND its projects."""
    ws = Workspace.load()
    ws.public_sharing = False
    ws.save()
    prog = Program.objects.create(name="Prog", public_sharing=True)
    p = _project(calendar, program=prog)  # NULL override → inherits program

    assert resolve_effective_sharing(prog, "public_sharing") is True
    assert resolve_effective_sharing(p, "public_sharing") is True
    # inherited_* skips the object's own override → the parent's effective value.
    assert resolve_inherited_sharing(p, "public_sharing") is True


@pytest.mark.django_db
def test_project_override_wins_over_program_and_workspace(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.public_sharing = False
    ws.save()
    prog = Program.objects.create(name="Prog", public_sharing=False)
    p = _project(calendar, program=prog, public_sharing=True)

    assert resolve_effective_sharing(p, "public_sharing") is True
    # With the project's own override cleared it would inherit the program (False).
    assert resolve_inherited_sharing(p, "public_sharing") is False


@pytest.mark.django_db
def test_standalone_project_inherits_workspace(calendar: Calendar) -> None:
    """A project with no program inherits the workspace value directly."""
    ws = Workspace.load()
    ws.public_sharing = True
    ws.save()
    p = _project(calendar)  # no program, NULL override

    assert p.program_id is None
    assert resolve_effective_sharing(p, "public_sharing") is True
    assert resolve_inherited_sharing(p, "public_sharing") is True


@pytest.mark.django_db
def test_inherited_skips_own_override_falls_to_program(calendar: Calendar) -> None:
    """inherited_* answers "what if my override were cleared" — never my own value."""
    ws = Workspace.load()
    ws.public_sharing = False
    ws.save()
    prog = Program.objects.create(name="Prog", public_sharing=True)
    p = _project(calendar, program=prog, public_sharing=False)

    assert resolve_effective_sharing(p, "public_sharing") is False  # own override
    assert resolve_inherited_sharing(p, "public_sharing") is True  # program's value


# ---------------------------------------------------------------------------
# ENFORCE enterprise seam
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_enforce_is_noop_in_oss(calendar: Calendar) -> None:
    """ENFORCE with no provider (OSS default) degrades to SUGGEST: override wins."""
    ws = Workspace.load()
    ws.public_sharing = False
    ws.public_sharing_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    prog = Program.objects.create(name="Prog", public_sharing=True)
    p = _project(calendar, program=prog, public_sharing=True)

    assert sharing_enforcement_active() is False
    assert resolve_effective_sharing(prog, "public_sharing") is True
    assert resolve_effective_sharing(p, "public_sharing") is True


@pytest.mark.django_db
def test_enforce_locks_to_workspace_when_provider_active(
    calendar: Calendar, enterprise_lock: None
) -> None:
    """ENFORCE + active provider: the workspace value is a ceiling, overrides ignored."""
    ws = Workspace.load()
    ws.public_sharing = False
    ws.public_sharing_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    prog = Program.objects.create(name="Prog", public_sharing=True)
    p = _project(calendar, program=prog, public_sharing=True)

    assert sharing_enforcement_active() is True
    # Both the program and project overrides are overridden by the ws ceiling.
    assert resolve_effective_sharing(prog, "public_sharing") is False
    assert resolve_effective_sharing(p, "public_sharing") is False
    # Under the lock the inherited value is also the (ceiling) workspace value.
    assert resolve_inherited_sharing(p, "public_sharing") is False


@pytest.mark.django_db
def test_suggest_policy_never_locks_even_with_provider(
    calendar: Calendar, enterprise_lock: None
) -> None:
    """SUGGEST (the default policy) never locks, even when a provider is active."""
    ws = Workspace.load()
    ws.public_sharing = False
    ws.public_sharing_override_policy = TermOverridePolicy.SUGGEST
    ws.save()
    p = _project(calendar, public_sharing=True)

    assert sharing_enforcement_active() is True
    assert resolve_effective_sharing(p, "public_sharing") is True


# ---------------------------------------------------------------------------
# Serializer output — effective_* / inherited_*
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_serializer_exposes_effective_and_inherited(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.public_sharing = False
    ws.allow_guests = True
    ws.save()
    prog = Program.objects.create(name="Prog", public_sharing=True)
    p = _project(calendar, program=prog)  # NULL overrides → inherits program/ws
    client = _client_for_project(p, Role.MEMBER, "u_proj_read")

    resp = client.get(f"/api/v1/projects/{p.pk}/")
    assert resp.status_code == 200
    assert resp.data["public_sharing"] is None
    assert resp.data["allow_guests"] is None
    assert resp.data["effective_public_sharing"] is True  # program override
    assert resp.data["effective_allow_guests"] is True  # workspace value
    # inherited = value with this object's override cleared (program/ws values).
    assert resp.data["inherited_public_sharing"] is True
    assert resp.data["inherited_allow_guests"] is True


@pytest.mark.django_db
def test_project_serializer_inherited_skips_own_override(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.public_sharing = False
    ws.save()
    p = _project(calendar, public_sharing=True)  # own override True
    client = _client_for_project(p, Role.MEMBER, "u_proj_skip")

    resp = client.get(f"/api/v1/projects/{p.pk}/")
    assert resp.status_code == 200
    assert resp.data["effective_public_sharing"] is True  # own override
    assert resp.data["inherited_public_sharing"] is False  # workspace value


@pytest.mark.django_db
def test_program_serializer_exposes_effective_and_inherited(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.public_sharing = True
    ws.save()
    prog = Program.objects.create(name="Prog")  # NULL override → inherits ws
    client = _client_for_program(prog, Role.MEMBER, "u_prog_read")

    resp = client.get(f"/api/v1/programs/{prog.pk}/")
    assert resp.status_code == 200
    assert resp.data["public_sharing"] is None
    assert resp.data["effective_public_sharing"] is True  # workspace value
    assert resp.data["inherited_public_sharing"] is True  # workspace value


# ---------------------------------------------------------------------------
# RBAC write gating — project override (validate() 400 below ADMIN)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.ADMIN, Role.OWNER])
def test_project_admin_can_set_override(calendar: Calendar, role: int) -> None:
    p = _project(calendar)
    client = _client_for_project(p, role, f"u_proj_admin_{int(role)}")
    resp = client.patch(
        f"/api/v1/projects/{p.pk}/", {"public_sharing": True}, format="json"
    )
    assert resp.status_code == 200, resp.content
    p.refresh_from_db()
    assert p.public_sharing is True
    assert resp.data["effective_public_sharing"] is True


@pytest.mark.django_db
def test_project_scheduler_cannot_set_override(calendar: Calendar) -> None:
    """Sharing fields are not in ``_SCHEDULER_WRITABLE_FIELDS`` → Scheduler 400."""
    p = _project(calendar)
    client = _client_for_project(p, Role.SCHEDULER, "u_proj_sched")
    resp = client.patch(
        f"/api/v1/projects/{p.pk}/", {"public_sharing": True}, format="json"
    )
    assert resp.status_code == 400
    p.refresh_from_db()
    assert p.public_sharing is None


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER])
def test_project_below_scheduler_blocked_at_gate(calendar: Calendar, role: int) -> None:
    """Viewer/Member never reach the serializer — blocked at the permission gate (403)."""
    p = _project(calendar)
    client = _client_for_project(p, role, f"u_proj_low_{int(role)}")
    resp = client.patch(
        f"/api/v1/projects/{p.pk}/", {"public_sharing": True}, format="json"
    )
    assert resp.status_code == 403
    p.refresh_from_db()
    assert p.public_sharing is None


@pytest.mark.django_db
def test_project_patch_null_clears_override(calendar: Calendar) -> None:
    """PATCH null clears the override so the project inherits again."""
    ws = Workspace.load()
    ws.public_sharing = True
    ws.save()
    p = _project(calendar, public_sharing=False)  # overriding to False
    client = _client_for_project(p, Role.ADMIN, "u_proj_clear")

    resp = client.patch(
        f"/api/v1/projects/{p.pk}/", {"public_sharing": None}, format="json"
    )
    assert resp.status_code == 200, resp.content
    p.refresh_from_db()
    assert p.public_sharing is None
    assert resp.data["effective_public_sharing"] is True  # back to workspace value


# ---------------------------------------------------------------------------
# RBAC write gating — program override (ADMIN+ gate, 403 below)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.ADMIN, Role.OWNER])
def test_program_admin_can_set_override(role: int) -> None:
    prog = Program.objects.create(name="Prog")
    client = _client_for_program(prog, role, f"u_prog_admin_{int(role)}")
    resp = client.patch(
        f"/api/v1/programs/{prog.pk}/", {"public_sharing": True}, format="json"
    )
    assert resp.status_code == 200, resp.content
    prog.refresh_from_db()
    assert prog.public_sharing is True
    assert resp.data["effective_public_sharing"] is True


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.SCHEDULER, Role.MEMBER, Role.VIEWER])
def test_program_non_admin_cannot_set_override(role: int) -> None:
    """Below ADMIN the program viewset gate rejects the write (403)."""
    prog = Program.objects.create(name="Prog")
    client = _client_for_program(prog, role, f"u_prog_low_{int(role)}")
    resp = client.patch(
        f"/api/v1/programs/{prog.pk}/", {"public_sharing": True}, format="json"
    )
    assert resp.status_code == 403
    prog.refresh_from_db()
    assert prog.public_sharing is None


@pytest.mark.django_db
def test_program_patch_null_clears_override() -> None:
    ws = Workspace.load()
    ws.public_sharing = True
    ws.save()
    prog = Program.objects.create(name="Prog", public_sharing=False)
    client = _client_for_program(prog, Role.ADMIN, "u_prog_clear")

    resp = client.patch(
        f"/api/v1/programs/{prog.pk}/", {"public_sharing": None}, format="json"
    )
    assert resp.status_code == 200, resp.content
    prog.refresh_from_db()
    assert prog.public_sharing is None
    assert resp.data["effective_public_sharing"] is True  # back to workspace value
