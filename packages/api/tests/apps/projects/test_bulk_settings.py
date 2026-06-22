"""Tests for the bulk-PATCH inherited-settings endpoints (ADR-0161, #1233).

Two scopes on ``ProgramViewSet``:
  * Workspace → Programs: ``POST /api/v1/programs/bulk-fields/`` (workspace-admin).
  * Program → Projects:   ``POST /api/v1/programs/{pk}/bulk-project-fields/`` (program-admin).

Covers: happy path (both scopes), partial field map (only named fields change), RBAC
denial, IDOR / out-of-scope ids, closed/non-bulk-editable scoping, unknown-field and
bad-value validation, empty-envelope rejection, and the ``server_version`` bump that keeps
offline sync correct.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import (
    Calendar,
    Methodology,
    Program,
    Project,
    SlipPropagation,
)
from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

User = get_user_model()

WORKSPACE_URL = "/api/v1/programs/bulk-fields/"


def _projects_url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/bulk-project-fields/"


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def ws_admin(db: object) -> object:
    user = User.objects.create_user(username="wsadmin", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.ADMIN
    )
    return user


@pytest.fixture
def plain_user(db: object) -> object:
    # No workspace membership row → resolves to the implicit MEMBER default.
    return User.objects.create_user(username="plain", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


def _program(name: str, **kw: object) -> Program:
    return Program.objects.create(name=name, **kw)


def _project(program: Program, calendar: Calendar, **kw: object) -> Project:
    return Project.objects.create(
        name="P", start_date=date(2026, 3, 1), calendar=calendar, program=program, **kw
    )


# ===========================================================================
# Workspace → Programs scope
# ===========================================================================


@pytest.mark.django_db
def test_workspace_admin_bulk_sets_fields(ws_admin: object) -> None:
    a = _program("A")
    b = _program("B")
    untouched = _program("C")
    base_a, base_b = a.server_version, b.server_version

    resp = _client(ws_admin).post(
        WORKSPACE_URL,
        {
            "ids": [str(a.pk), str(b.pk)],
            "fields": {"methodology": Methodology.AGILE, "iteration_label": "PI"},
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert sorted(resp.data["fields"]) == ["iteration_label", "methodology"]
    assert {row["id"] for row in resp.data["updated"]} == {str(a.pk), str(b.pk)}

    a.refresh_from_db()
    b.refresh_from_db()
    untouched.refresh_from_db()
    assert a.methodology == Methodology.AGILE and a.iteration_label == "PI"
    assert b.methodology == Methodology.AGILE and b.iteration_label == "PI"
    # Per-row save() bumped server_version (offline-sync delta key).
    assert a.server_version > base_a and b.server_version > base_b
    # A program not in `ids` keeps inheriting (default HYBRID, null label).
    assert untouched.methodology == Methodology.HYBRID and untouched.iteration_label is None


@pytest.mark.django_db
def test_only_named_fields_change(ws_admin: object) -> None:
    p = _program("A", iteration_label="Sprint", risk_escalation_days=7)
    resp = _client(ws_admin).post(
        WORKSPACE_URL,
        {"ids": [str(p.pk)], "fields": {"methodology": Methodology.WATERFALL}},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    p.refresh_from_db()
    assert p.methodology == Methodology.WATERFALL
    # Unnamed fields are left exactly as they were — not reset.
    assert p.iteration_label == "Sprint"
    assert p.risk_escalation_days == 7


@pytest.mark.django_db
def test_risk_fields_bulk_set(ws_admin: object) -> None:
    p = _program("A")
    resp = _client(ws_admin).post(
        WORKSPACE_URL,
        {
            "ids": [str(p.pk)],
            "fields": {"risk_slip_propagation": SlipPropagation.BLOCK, "risk_escalation_days": 14},
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    p.refresh_from_db()
    assert p.risk_slip_propagation == SlipPropagation.BLOCK
    assert p.risk_escalation_days == 14


@pytest.mark.django_db
def test_clear_iteration_label_to_inherit(ws_admin: object) -> None:
    p = _program("A", iteration_label="Wave")
    resp = _client(ws_admin).post(
        WORKSPACE_URL, {"ids": [str(p.pk)], "fields": {"iteration_label": None}}, format="json"
    )
    assert resp.status_code == 200, resp.content
    p.refresh_from_db()
    assert p.iteration_label is None  # null = inherit (ADR-0116)


@pytest.mark.django_db
def test_non_admin_workspace_member_forbidden(plain_user: object) -> None:
    p = _program("A")
    resp = _client(plain_user).post(
        WORKSPACE_URL,
        {"ids": [str(p.pk)], "fields": {"methodology": Methodology.AGILE}},
        format="json",
    )
    assert resp.status_code == 403
    p.refresh_from_db()
    assert p.methodology == Methodology.HYBRID  # unchanged


@pytest.mark.django_db
def test_unauthenticated_rejected() -> None:
    p = _program("A")
    resp = APIClient().post(
        WORKSPACE_URL,
        {"ids": [str(p.pk)], "fields": {"methodology": Methodology.AGILE}},
        format="json",
    )
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_unknown_field_rejected(ws_admin: object) -> None:
    p = _program("A")
    # `calendar` is deliberately not bulk-editable in this slice → explicit 400.
    resp = _client(ws_admin).post(
        WORKSPACE_URL,
        {"ids": [str(p.pk)], "fields": {"calendar": str(uuid.uuid4())}},
        format="json",
    )
    assert resp.status_code == 400
    assert "fields" in resp.data


@pytest.mark.django_db
@pytest.mark.parametrize(
    "fields",
    [
        {"methodology": "NONSENSE"},
        {"risk_escalation_days": 99},  # out of 1..30
        {"risk_escalation_days": 0},
        {"iteration_label": "   "},  # whitespace-only is not "inherit" (use null)
    ],
)
def test_invalid_value_rejected(ws_admin: object, fields: dict[str, object]) -> None:
    p = _program("A")
    resp = _client(ws_admin).post(
        WORKSPACE_URL, {"ids": [str(p.pk)], "fields": fields}, format="json"
    )
    assert resp.status_code == 400, resp.content
    p.refresh_from_db()
    assert p.methodology == Methodology.HYBRID and p.risk_escalation_days == 3


@pytest.mark.django_db
def test_unknown_id_rejected_atomically(ws_admin: object) -> None:
    real = _program("A")
    ghost = str(uuid.uuid4())
    resp = _client(ws_admin).post(
        WORKSPACE_URL,
        {"ids": [str(real.pk), ghost], "fields": {"methodology": Methodology.AGILE}},
        format="json",
    )
    assert resp.status_code == 400
    # All-or-nothing: the real program must NOT have been updated.
    real.refresh_from_db()
    assert real.methodology == Methodology.HYBRID


@pytest.mark.django_db
def test_closed_program_out_of_scope(ws_admin: object) -> None:
    closed = _program("A", is_closed=True)
    resp = _client(ws_admin).post(
        WORKSPACE_URL,
        {"ids": [str(closed.pk)], "fields": {"methodology": Methodology.AGILE}},
        format="json",
    )
    assert resp.status_code == 400  # filtered out by is_closed=False → "outside scope"
    closed.refresh_from_db()
    assert closed.methodology == Methodology.HYBRID


@pytest.mark.django_db
@pytest.mark.parametrize(
    "body", [{"ids": [], "fields": {"methodology": "AGILE"}}, {"ids": [], "fields": {}}]
)
def test_empty_ids_rejected(ws_admin: object, body: dict[str, object]) -> None:
    resp = _client(ws_admin).post(WORKSPACE_URL, body, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_empty_fields_rejected(ws_admin: object) -> None:
    p = _program("A")
    resp = _client(ws_admin).post(WORKSPACE_URL, {"ids": [str(p.pk)], "fields": {}}, format="json")
    assert resp.status_code == 400


# ===========================================================================
# Program → Projects scope
# ===========================================================================


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def program(owner: object) -> Program:
    # create_program makes the creator a program OWNER (→ passes IsProgramAdmin).
    return create_program(
        name="Phase 2", description="", methodology=Methodology.HYBRID, created_by=owner
    )


@pytest.mark.django_db
def test_program_admin_bulk_sets_project_fields(
    owner: object, program: Program, calendar: Calendar
) -> None:
    p1 = _project(program, calendar)
    p2 = _project(program, calendar)
    base1 = p1.server_version

    resp = _client(owner).post(
        _projects_url(program),
        {
            "ids": [str(p1.pk), str(p2.pk)],
            "fields": {"methodology": Methodology.AGILE, "iteration_label": "Cycle"},
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    p1.refresh_from_db()
    p2.refresh_from_db()
    assert p1.methodology == Methodology.AGILE and p1.iteration_label == "Cycle"
    assert p2.methodology == Methodology.AGILE and p2.iteration_label == "Cycle"
    assert p1.server_version > base1


@pytest.mark.django_db
def test_program_member_forbidden(owner: object, program: Program, calendar: Calendar) -> None:
    member = User.objects.create_user(username="member", password="pw")
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    proj = _project(program, calendar)
    resp = _client(member).post(
        _projects_url(program),
        {"ids": [str(proj.pk)], "fields": {"methodology": Methodology.AGILE}},
        format="json",
    )
    assert resp.status_code == 403
    proj.refresh_from_db()
    assert proj.methodology == Methodology.HYBRID


@pytest.mark.django_db
def test_idor_foreign_project_rejected(owner: object, program: Program, calendar: Calendar) -> None:
    """A project from another program is out-of-scope (the URL program PK is the boundary)."""
    other_owner = User.objects.create_user(username="o2", password="pw")
    other_program = create_program(
        name="Other", description="", methodology=Methodology.HYBRID, created_by=other_owner
    )
    foreign = _project(other_program, calendar)

    resp = _client(owner).post(
        _projects_url(program),
        {"ids": [str(foreign.pk)], "fields": {"methodology": Methodology.AGILE}},
        format="json",
    )
    assert resp.status_code == 400
    foreign.refresh_from_db()
    assert foreign.methodology == Methodology.HYBRID  # untouched


@pytest.mark.django_db
def test_project_scope_rejects_program_only_field(
    owner: object, program: Program, calendar: Calendar
) -> None:
    proj = _project(program, calendar)
    # risk_slip_propagation is a Program-only field — not bulk-editable in the project scope.
    resp = _client(owner).post(
        _projects_url(program),
        {"ids": [str(proj.pk)], "fields": {"risk_slip_propagation": SlipPropagation.BLOCK}},
        format="json",
    )
    assert resp.status_code == 400
    assert "fields" in resp.data


@pytest.mark.django_db
def test_archived_project_out_of_scope(owner: object, program: Program, calendar: Calendar) -> None:
    archived = _project(program, calendar, is_archived=True)
    resp = _client(owner).post(
        _projects_url(program),
        {"ids": [str(archived.pk)], "fields": {"methodology": Methodology.AGILE}},
        format="json",
    )
    assert resp.status_code == 400
    archived.refresh_from_db()
    assert archived.methodology == Methodology.HYBRID


@pytest.mark.django_db
def test_closed_program_blocks_project_bulk(
    owner: object, program: Program, calendar: Calendar
) -> None:
    proj = _project(program, calendar)
    program.is_closed = True
    program.save(update_fields=["is_closed"])
    resp = _client(owner).post(
        _projects_url(program),
        {"ids": [str(proj.pk)], "fields": {"methodology": Methodology.AGILE}},
        format="json",
    )
    assert resp.status_code == 403  # IsProgramNotClosed
