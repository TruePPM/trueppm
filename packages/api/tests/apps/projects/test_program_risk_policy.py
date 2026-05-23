"""Tests for the Program risk-policy endpoint (#529).

Covers:
- GET returns the persisted policy to any program member; non-members 404.
- PATCH requires program admin (Role.ADMIN+); lower roles 403.
- Defaults: ``slip_propagation="warn"`` and ``escalation_days=3`` (static —
  no methodology-aware seeding for risk policy, unlike rollup config).
- Validation rejects unknown slip_propagation values and escalation_days
  outside 1–30.
- Each PATCH writes a HistoricalProgram row (audit trail via simple-history).
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import Methodology, Program

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def admin_user(db: object) -> object:
    return User.objects.create_user(username="admin", password="pw")


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def stranger(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


@pytest.fixture
def program(owner: object) -> Program:
    return create_program(
        name="Phase 2", description="", methodology=Methodology.HYBRID, created_by=owner
    )


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(p: Program) -> str:
    return f"/api/v1/programs/{p.pk}/risk-policy/"


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_new_program_seeds_default_warn_3(owner: object, program: Program) -> None:
    """Static defaults per #529 spec — no methodology variation."""
    resp = _client(owner).get(_url(program))
    assert resp.status_code == 200, resp.content
    assert resp.data == {"slip_propagation": "warn", "escalation_days": 3}


@pytest.mark.django_db
@pytest.mark.parametrize("methodology", [Methodology.WATERFALL, Methodology.AGILE])
def test_defaults_are_methodology_independent(owner: object, methodology: str) -> None:
    p = create_program(name="X", description="", methodology=methodology, created_by=owner)
    resp = _client(owner).get(_url(p))
    assert resp.status_code == 200
    assert resp.data == {"slip_propagation": "warn", "escalation_days": 3}


# ---------------------------------------------------------------------------
# Permission matrix
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_get_allowed_for_viewer(owner: object, member: object, program: Program) -> None:
    ProgramMembership.objects.create(program=program, user=member, role=Role.VIEWER)
    resp = _client(member).get(_url(program))
    assert resp.status_code == 200


@pytest.mark.django_db
def test_get_404_for_non_member(stranger: object, program: Program) -> None:
    # Non-members get 404 via the get_queryset filter rather than 403 — the
    # program is not "in their universe", so it does not exist for them.
    resp = _client(stranger).get(_url(program))
    assert resp.status_code == 404


@pytest.mark.django_db
def test_patch_forbidden_for_member_role(owner: object, member: object, program: Program) -> None:
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    resp = _client(member).patch(_url(program), {"slip_propagation": "block"}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_patch_forbidden_for_scheduler_role(
    owner: object, member: object, program: Program
) -> None:
    ProgramMembership.objects.create(program=program, user=member, role=Role.SCHEDULER)
    resp = _client(member).patch(_url(program), {"slip_propagation": "block"}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_patch_allowed_for_admin_role(owner: object, admin_user: object, program: Program) -> None:
    ProgramMembership.objects.create(program=program, user=admin_user, role=Role.ADMIN)
    resp = _client(admin_user).patch(
        _url(program),
        {"slip_propagation": "block", "escalation_days": 7},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data == {"slip_propagation": "block", "escalation_days": 7}


@pytest.mark.django_db
def test_patch_allowed_for_owner_role(owner: object, program: Program) -> None:
    resp = _client(owner).patch(_url(program), {"slip_propagation": "none"}, format="json")
    assert resp.status_code == 200
    assert resp.data["slip_propagation"] == "none"


@pytest.mark.django_db
def test_unauthenticated_caller_rejected(program: Program) -> None:
    resp = APIClient().get(_url(program))
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_rejects_unknown_slip_propagation(owner: object, program: Program) -> None:
    resp = _client(owner).patch(_url(program), {"slip_propagation": "ignore"}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
@pytest.mark.parametrize("bad", [0, -1, 31, 100, 9999])
def test_patch_rejects_escalation_days_out_of_range(
    owner: object, program: Program, bad: int
) -> None:
    resp = _client(owner).patch(_url(program), {"escalation_days": bad}, format="json")
    assert resp.status_code == 400, f"escalation_days={bad} should be rejected"


@pytest.mark.django_db
@pytest.mark.parametrize("good", [1, 3, 15, 30])
def test_patch_accepts_escalation_days_in_range(owner: object, program: Program, good: int) -> None:
    resp = _client(owner).patch(_url(program), {"escalation_days": good}, format="json")
    assert resp.status_code == 200
    assert resp.data["escalation_days"] == good


# ---------------------------------------------------------------------------
# Partial PATCH
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_only_slip_propagation_leaves_days_unchanged(owner: object, program: Program) -> None:
    initial = _client(owner).get(_url(program)).data
    resp = _client(owner).patch(_url(program), {"slip_propagation": "block"}, format="json")
    assert resp.status_code == 200
    assert resp.data["slip_propagation"] == "block"
    assert resp.data["escalation_days"] == initial["escalation_days"]


@pytest.mark.django_db
def test_patch_only_escalation_days_leaves_slip_unchanged(owner: object, program: Program) -> None:
    initial = _client(owner).get(_url(program)).data
    resp = _client(owner).patch(_url(program), {"escalation_days": 14}, format="json")
    assert resp.status_code == 200
    assert resp.data["escalation_days"] == 14
    assert resp.data["slip_propagation"] == initial["slip_propagation"]


# ---------------------------------------------------------------------------
# Audit trail (HistoricalRecords on Program)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_creates_history_row(owner: object, program: Program) -> None:
    before = program.history.count()
    resp = _client(owner).patch(
        _url(program),
        {"slip_propagation": "block", "escalation_days": 10},
        format="json",
    )
    assert resp.status_code == 200
    program.refresh_from_db()
    after = program.history.count()
    assert after > before, "PATCH must create a HistoricalProgram row for audit"
    latest = program.history.first()
    assert latest.risk_slip_propagation == "block"
    assert latest.risk_escalation_days == 10
