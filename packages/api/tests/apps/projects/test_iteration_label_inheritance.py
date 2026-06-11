"""Workspace → Program → Project iteration-label inheritance (ADR-0116, #1106).

Covers the computed-on-read resolver precedence, the ENFORCE enterprise seam
(no-op in OSS, locks when a provider is registered), and the serializer's
``effective_iteration_label`` / ``inherited_iteration_label`` read fields.
Project-level RBAC for the override is covered by ``test_iteration_label.py``.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.iteration_label import (
    register_terminology_enforcement_provider,
    resolve_effective_iteration_label,
    terminology_enforcement_active,
)
from trueppm_api.apps.projects.models import Calendar, Program, Project
from trueppm_api.apps.workspace.models import TermOverridePolicy, Workspace

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


def _project(calendar: Calendar, **kw: object) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 3, 1), calendar=calendar, **kw)


@pytest.mark.django_db
def test_precedence_project_over_program_over_workspace(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.iteration_label = "WSLabel"
    ws.save()
    prog = Program.objects.create(name="Prog", iteration_label="ProgLabel")
    p = _project(calendar, program=prog, iteration_label="ProjLabel")

    # Project override wins.
    assert resolve_effective_iteration_label(p) == "ProjLabel"
    # Cleared → falls back to the program override.
    p.iteration_label = None
    p.save()
    assert resolve_effective_iteration_label(p) == "ProgLabel"
    # Program cleared too → falls back to the workspace default.
    prog.iteration_label = None
    prog.save()
    p.program.refresh_from_db()
    assert resolve_effective_iteration_label(p) == "WSLabel"


@pytest.mark.django_db
def test_workspace_default_for_standalone_project(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.iteration_label = "Iteration"
    ws.save()
    p = _project(calendar)  # no program, NULL override
    assert resolve_effective_iteration_label(p) == "Iteration"


@pytest.mark.django_db
def test_sprint_backstop_when_workspace_blank(calendar: Calendar) -> None:
    """Even a (defensively) blank workspace label resolves to the "Sprint" backstop."""
    ws = Workspace.load()
    ws.iteration_label = ""
    ws.save()
    p = _project(calendar)
    assert resolve_effective_iteration_label(p) == "Sprint"


@pytest.mark.django_db
def test_enforce_is_noop_in_oss(calendar: Calendar) -> None:
    """OSS registers no provider → ENFORCE degrades to SUGGEST: the project override wins."""
    ws = Workspace.load()
    ws.iteration_label = "WSLabel"
    ws.iteration_label_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    p = _project(calendar, iteration_label="ProjLabel")
    assert terminology_enforcement_active() is False
    assert resolve_effective_iteration_label(p) == "ProjLabel"


@pytest.mark.django_db
def test_enforce_locks_when_provider_active(calendar: Calendar) -> None:
    """With an enterprise provider registered, ENFORCE locks to the workspace label."""
    ws = Workspace.load()
    ws.iteration_label = "WSLabel"
    ws.iteration_label_override_policy = TermOverridePolicy.ENFORCE
    ws.save()
    p = _project(calendar, iteration_label="ProjLabel")
    register_terminology_enforcement_provider(lambda: True)
    try:
        assert terminology_enforcement_active() is True
        assert resolve_effective_iteration_label(p) == "WSLabel"
    finally:
        register_terminology_enforcement_provider(None)


@pytest.mark.django_db
def test_serializer_exposes_effective_and_inherited(calendar: Calendar) -> None:
    ws = Workspace.load()
    ws.iteration_label = "WSLabel"
    ws.save()
    prog = Program.objects.create(name="Prog", iteration_label="ProgLabel")
    p = _project(calendar, program=prog)  # NULL override → inherits the program label
    user = User.objects.create_user(username="u_inh", password="pw")
    ProjectMembership.objects.create(project=p, user=user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.get(f"/api/v1/projects/{p.pk}/")
    assert resp.status_code == 200
    assert resp.data["iteration_label"] is None
    assert resp.data["effective_iteration_label"] == "ProgLabel"
    # inherited = what it WOULD show with the override cleared (here, also ProgLabel).
    assert resp.data["inherited_iteration_label"] == "ProgLabel"


@pytest.mark.django_db
def test_clear_override_via_patch_inherits(calendar: Calendar) -> None:
    """PATCH iteration_label: null clears the override so the project inherits again."""
    ws = Workspace.load()
    ws.iteration_label = "WSLabel"
    ws.save()
    p = _project(calendar, iteration_label="ProjLabel")
    admin = User.objects.create_user(username="u_admin_clear", password="pw")
    ProjectMembership.objects.create(project=p, user=admin, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=admin)

    resp = client.patch(f"/api/v1/projects/{p.pk}/", {"iteration_label": None}, format="json")
    assert resp.status_code == 200
    p.refresh_from_db()
    assert p.iteration_label is None
    assert resp.data["effective_iteration_label"] == "WSLabel"
