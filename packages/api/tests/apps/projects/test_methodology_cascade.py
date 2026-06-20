"""Workspace → Program → Project methodology cascade (ADR-0107, issues 955 / 1169).

Methodology (``AGILE`` / ``WATERFALL`` / ``HYBRID``) is the experience preset that
hides one workflow's chrome from the other (ADR-0041). Unlike iteration_label /
sharing inheritance it is **NOT-NULL at every scope** — there is no null "inherit"
sentinel — so inheritance is *policy-driven*, switched by the workspace's
``methodology_override_policy``:

- ``SUGGEST`` (default): each scope's own methodology wins; precedence
  project → program → workspace.
- ``INHERIT``: the workspace default wins everywhere; per-scope picker is read-only
  and a direct API override is refused (403).
- ``ENFORCE``: Enterprise-only lock. OSS registers no provider, so it degrades to
  SUGGEST (no lock); with an active provider it behaves like INHERIT.

Covers: model default, resolver precedence across all three scopes, the policy
lock (INHERIT and active-provider ENFORCE), the ENFORCE OSS no-op, the serializer
``effective_methodology`` / ``inherited_methodology`` read fields, the ADMIN+ write
gate, the 403 under a lock, and the HistoricalWorkspace audit write.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.methodology import (
    DEFAULT_METHODOLOGY,
    methodology_enforcement_active,
    methodology_override_locked,
    register_methodology_enforcement_provider,
    resolve_effective_methodology,
    resolve_inherited_methodology,
)
from trueppm_api.apps.projects.models import Calendar, Methodology, Program, Project
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
    """Register an active methodology-enforcement provider, clearing on teardown.

    OSS registers no provider, so a test that wants the ENFORCE lock must register
    one — and MUST clear it (module-global state) or it leaks into later tests.
    """
    register_methodology_enforcement_provider(lambda: True)
    try:
        yield
    finally:
        register_methodology_enforcement_provider(None)


# ---------------------------------------------------------------------------
# Model default
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_workspace_methodology_defaults_to_hybrid() -> None:
    """A fresh workspace defaults to HYBRID (lossless — every tab visible)."""
    ws = Workspace.load()
    assert ws.methodology == Methodology.HYBRID
    assert ws.methodology_override_policy == TermOverridePolicy.SUGGEST
    assert DEFAULT_METHODOLOGY == Methodology.HYBRID


# ---------------------------------------------------------------------------
# Resolver precedence under SUGGEST (no HTTP)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_suggest_project_own_value_wins(calendar: Calendar) -> None:
    """SUGGEST: the project's own methodology beats program and workspace."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.save()
    prog = Program.objects.create(name="Prog", methodology=Methodology.HYBRID)
    p = _project(calendar, program=prog, methodology=Methodology.AGILE)

    assert resolve_effective_methodology(p) == Methodology.AGILE
    # inherited skips the project's own value → the program tier (HYBRID).
    assert resolve_inherited_methodology(p) == Methodology.HYBRID


@pytest.mark.django_db
def test_suggest_program_inherited_by_standalone_resolution(calendar: Calendar) -> None:
    """SUGGEST: a program's own methodology is its effective value; projects in it
    resolve their own value, and inherited falls to the program."""
    ws = Workspace.load()
    ws.methodology = Methodology.HYBRID
    ws.save()
    prog = Program.objects.create(name="Prog", methodology=Methodology.WATERFALL)
    p = _project(calendar, program=prog, methodology=Methodology.AGILE)

    assert resolve_effective_methodology(prog) == Methodology.WATERFALL
    assert resolve_effective_methodology(p) == Methodology.AGILE
    assert resolve_inherited_methodology(p) == Methodology.WATERFALL  # program tier


@pytest.mark.django_db
def test_suggest_program_effective_falls_to_workspace_when_unset(calendar: Calendar) -> None:
    """A program whose methodology is blank resolves up to the workspace default."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.save()
    prog = Program.objects.create(name="Prog", methodology="")  # blank → inherit ws

    assert resolve_effective_methodology(prog) == Methodology.WATERFALL
    assert resolve_inherited_methodology(prog) == Methodology.WATERFALL


# ---------------------------------------------------------------------------
# Policy lock — INHERIT
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_inherit_policy_forces_workspace_default(calendar: Calendar) -> None:
    """INHERIT: the workspace default wins for program and project regardless of
    their own (otherwise-honored) values."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.methodology_override_policy = TermOverridePolicy.INHERIT
    ws.save()
    prog = Program.objects.create(name="Prog", methodology=Methodology.AGILE)
    p = _project(calendar, program=prog, methodology=Methodology.AGILE)

    assert methodology_override_locked(ws) is True
    assert resolve_effective_methodology(prog) == Methodology.WATERFALL
    assert resolve_effective_methodology(p) == Methodology.WATERFALL
    assert resolve_inherited_methodology(p) == Methodology.WATERFALL


# ---------------------------------------------------------------------------
# ENFORCE enterprise seam
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_enforce_is_noop_in_oss(calendar: Calendar) -> None:
    """ENFORCE with no provider (OSS default) degrades to SUGGEST: override wins."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.methodology_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    p = _project(calendar, methodology=Methodology.AGILE)

    assert methodology_enforcement_active() is False
    assert methodology_override_locked(ws) is False
    assert resolve_effective_methodology(p) == Methodology.AGILE


@pytest.mark.django_db
def test_enforce_locks_to_workspace_when_provider_active(
    calendar: Calendar, enterprise_lock: None
) -> None:
    """ENFORCE + active provider: the workspace default is mandatory; overrides lost."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.methodology_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    prog = Program.objects.create(name="Prog", methodology=Methodology.AGILE)
    p = _project(calendar, program=prog, methodology=Methodology.AGILE)

    assert methodology_enforcement_active() is True
    assert methodology_override_locked(ws) is True
    assert resolve_effective_methodology(prog) == Methodology.WATERFALL
    assert resolve_effective_methodology(p) == Methodology.WATERFALL


@pytest.mark.django_db
def test_suggest_never_locks_even_with_provider(calendar: Calendar, enterprise_lock: None) -> None:
    """SUGGEST (default) never locks, even when a provider is active."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.methodology_override_policy = TermOverridePolicy.SUGGEST
    ws.save()
    p = _project(calendar, methodology=Methodology.AGILE)

    assert methodology_enforcement_active() is True
    assert methodology_override_locked(ws) is False
    assert resolve_effective_methodology(p) == Methodology.AGILE


# ---------------------------------------------------------------------------
# Serializer output — effective_* / inherited_*
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_serializer_exposes_effective_and_inherited(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.save()
    prog = Program.objects.create(name="Prog", methodology=Methodology.AGILE)
    p = _project(calendar, program=prog, methodology=Methodology.HYBRID)
    client = _client_for_project(p, Role.MEMBER, "u_proj_read")

    resp = client.get(f"/api/v1/projects/{p.pk}/")
    assert resp.status_code == 200
    assert resp.data["methodology"] == Methodology.HYBRID  # raw own value
    assert resp.data["effective_methodology"] == Methodology.HYBRID  # own wins (SUGGEST)
    assert resp.data["inherited_methodology"] == Methodology.AGILE  # program tier


@pytest.mark.django_db
def test_program_serializer_exposes_effective_and_inherited(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.save()
    prog = Program.objects.create(name="Prog", methodology=Methodology.AGILE)
    client = _client_for_program(prog, Role.MEMBER, "u_prog_read")

    resp = client.get(f"/api/v1/programs/{prog.pk}/")
    assert resp.status_code == 200
    assert resp.data["methodology"] == Methodology.AGILE
    assert resp.data["effective_methodology"] == Methodology.AGILE
    assert resp.data["inherited_methodology"] == Methodology.WATERFALL  # workspace default


@pytest.mark.django_db
def test_serializer_effective_reflects_inherit_lock(calendar: Calendar) -> None:
    """Under INHERIT the serializer's effective_methodology is the workspace value,
    not the project's own raw methodology — clients gate tabs on this."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.methodology_override_policy = TermOverridePolicy.INHERIT
    ws.save()
    p = _project(calendar, methodology=Methodology.AGILE)
    client = _client_for_project(p, Role.MEMBER, "u_proj_locked")

    resp = client.get(f"/api/v1/projects/{p.pk}/")
    assert resp.status_code == 200
    assert resp.data["methodology"] == Methodology.AGILE  # raw stays as stored
    assert resp.data["effective_methodology"] == Methodology.WATERFALL  # lock wins
    assert resp.data["inherited_methodology"] == Methodology.WATERFALL


# ---------------------------------------------------------------------------
# Workspace settings serializer write + audit
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_workspace_settings_patch_sets_methodology_and_policy() -> None:
    """An admin can set the workspace methodology + override policy via settings."""
    user = User.objects.create_user(username="ws_admin", password="pw", is_superuser=True)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.patch(
        "/api/v1/workspace/",
        {"methodology": Methodology.AGILE, "methodology_override_policy": "inherit"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    ws = Workspace.load()
    assert ws.methodology == Methodology.AGILE
    assert ws.methodology_override_policy == TermOverridePolicy.INHERIT


@pytest.mark.django_db
def test_workspace_methodology_change_is_audited() -> None:
    """The workspace gained a history table for the methodology audit trail —
    enterprise consumes ``history_record_created`` for retention evidence."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.save()

    # The simple_history accessor exists and recorded the change.
    history = ws.history.all()
    assert history.exists()
    assert history.first().methodology == Methodology.WATERFALL


# ---------------------------------------------------------------------------
# RBAC write gating on the per-scope override
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_methodology_override_allowed_under_suggest(calendar: Calendar) -> None:
    """Default SUGGEST policy: an Admin override is honored (no lock)."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.save()
    p = _project(calendar, methodology=Methodology.WATERFALL)
    client = _client_for_project(p, Role.ADMIN, "u_proj_admin")

    resp = client.patch(
        f"/api/v1/projects/{p.pk}/", {"methodology": Methodology.AGILE}, format="json"
    )
    assert resp.status_code == 200, resp.content
    p.refresh_from_db()
    assert p.methodology == Methodology.AGILE
    assert resp.data["effective_methodology"] == Methodology.AGILE


@pytest.mark.django_db
def test_project_methodology_override_403_under_inherit(calendar: Calendar) -> None:
    """INHERIT lock: a direct API methodology change is refused with 403 (policy
    refusal, not a bad value). The picker is read-only in the UI; this is the
    server-side backstop."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.methodology_override_policy = TermOverridePolicy.INHERIT
    ws.save()
    p = _project(calendar, methodology=Methodology.WATERFALL)
    client = _client_for_project(p, Role.ADMIN, "u_proj_locked_w")

    resp = client.patch(
        f"/api/v1/projects/{p.pk}/", {"methodology": Methodology.AGILE}, format="json"
    )
    assert resp.status_code == 403
    p.refresh_from_db()
    assert p.methodology == Methodology.WATERFALL  # unchanged


@pytest.mark.django_db
def test_project_methodology_unchanged_value_is_noop_under_lock(calendar: Calendar) -> None:
    """Re-sending the current methodology under a lock is a harmless no-op (200),
    never a 403 — only a *change* is blocked."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.methodology_override_policy = TermOverridePolicy.INHERIT
    ws.save()
    p = _project(calendar, methodology=Methodology.AGILE)
    client = _client_for_project(p, Role.ADMIN, "u_proj_noop")

    resp = client.patch(
        f"/api/v1/projects/{p.pk}/", {"methodology": Methodology.AGILE}, format="json"
    )
    assert resp.status_code == 200, resp.content


@pytest.mark.django_db
def test_program_methodology_override_403_under_inherit() -> None:
    """Program mirror of the INHERIT 403 backstop."""
    ws = Workspace.load()
    ws.methodology = Methodology.WATERFALL
    ws.methodology_override_policy = TermOverridePolicy.INHERIT
    ws.save()
    prog = Program.objects.create(name="Prog", methodology=Methodology.WATERFALL)
    client = _client_for_program(prog, Role.ADMIN, "u_prog_locked")

    resp = client.patch(
        f"/api/v1/programs/{prog.pk}/", {"methodology": Methodology.AGILE}, format="json"
    )
    assert resp.status_code == 403
    prog.refresh_from_db()
    assert prog.methodology == Methodology.WATERFALL
