"""Tests for the Program rollup-config endpoint (#527, ADR-0079).

Covers:
- GET returns the persisted config to any program member; non-members 404.
- PATCH requires program admin (Role.ADMIN+); lower roles 403.
- Methodology-aware defaults seed correctly on Program creation.
- Validation rejects unknown KPI identifiers and over-long lists.
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
def hybrid_program(owner: object) -> Program:
    # ``create_program`` is the same atomic service the viewset uses on POST;
    # it creates the Program and the OWNER membership in one transaction.
    return create_program(
        name="Phase 2", description="", methodology=Methodology.HYBRID, created_by=owner
    )


@pytest.fixture
def waterfall_program(owner: object) -> Program:
    return create_program(
        name="WF", description="", methodology=Methodology.WATERFALL, created_by=owner
    )


@pytest.fixture
def agile_program(owner: object) -> Program:
    return create_program(
        name="AG", description="", methodology=Methodology.AGILE, created_by=owner
    )


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/rollup-config/"


# ---------------------------------------------------------------------------
# Methodology-aware defaults
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_waterfall_program_seeds_waterfall_defaults(
    owner: object, waterfall_program: Program
) -> None:
    resp = _client(owner).get(_url(waterfall_program))
    assert resp.status_code == 200, resp.content
    assert set(resp.data["enabled_kpis"]) == {
        "schedule_health",
        "baseline_variance",
        "critical_tasks",
        "milestone_health",
        "budget_utilization",
        "cost_variance",
    }
    assert resp.data["aggregation_policy"] == "worst"


@pytest.mark.django_db
def test_agile_program_seeds_agile_defaults(owner: object, agile_program: Program) -> None:
    resp = _client(owner).get(_url(agile_program))
    assert resp.status_code == 200
    assert set(resp.data["enabled_kpis"]) == {
        "milestone_health",
        "p80_completion",
        "at_risk_tasks",
        "risk_score",
    }


@pytest.mark.django_db
def test_hybrid_program_seeds_union_defaults(owner: object, hybrid_program: Program) -> None:
    resp = _client(owner).get(_url(hybrid_program))
    assert resp.status_code == 200
    # Union of waterfall + agile, de-duplicated. Order is preserved by the
    # seeder but the set membership is what matters for downstream UI.
    assert "milestone_health" in resp.data["enabled_kpis"]
    assert "schedule_health" in resp.data["enabled_kpis"]
    assert "p80_completion" in resp.data["enabled_kpis"]
    # No duplicates from the union.
    assert len(resp.data["enabled_kpis"]) == len(set(resp.data["enabled_kpis"]))


# ---------------------------------------------------------------------------
# Permission matrix
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_get_allowed_for_viewer(owner: object, member: object, hybrid_program: Program) -> None:
    ProgramMembership.objects.create(program=hybrid_program, user=member, role=Role.VIEWER)
    resp = _client(member).get(_url(hybrid_program))
    assert resp.status_code == 200


@pytest.mark.django_db
def test_get_404_for_non_member(stranger: object, hybrid_program: Program) -> None:
    resp = _client(stranger).get(_url(hybrid_program))
    # Non-members get 404 via the get_queryset filter rather than 403 — the
    # program is not "in their universe", so it does not exist for them.
    assert resp.status_code == 404


@pytest.mark.django_db
def test_patch_forbidden_for_member_role(
    owner: object, member: object, hybrid_program: Program
) -> None:
    ProgramMembership.objects.create(program=hybrid_program, user=member, role=Role.MEMBER)
    resp = _client(member).patch(
        _url(hybrid_program),
        {"enabled_kpis": ["schedule_health"]},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_patch_forbidden_for_scheduler_role(
    owner: object, member: object, hybrid_program: Program
) -> None:
    ProgramMembership.objects.create(program=hybrid_program, user=member, role=Role.SCHEDULER)
    resp = _client(member).patch(
        _url(hybrid_program),
        {"enabled_kpis": ["schedule_health"]},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_patch_allowed_for_admin_role(
    owner: object, admin_user: object, hybrid_program: Program
) -> None:
    ProgramMembership.objects.create(program=hybrid_program, user=admin_user, role=Role.ADMIN)
    resp = _client(admin_user).patch(
        _url(hybrid_program),
        {"enabled_kpis": ["schedule_health", "critical_tasks"]},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["enabled_kpis"] == ["schedule_health", "critical_tasks"]


@pytest.mark.django_db
def test_patch_allowed_for_owner_role(owner: object, hybrid_program: Program) -> None:
    resp = _client(owner).patch(
        _url(hybrid_program),
        {"aggregation_policy": "average"},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["aggregation_policy"] == "average"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_rejects_unknown_kpi(owner: object, hybrid_program: Program) -> None:
    resp = _client(owner).patch(
        _url(hybrid_program),
        {"enabled_kpis": ["schedule_health", "made_up_kpi"]},
        format="json",
    )
    assert resp.status_code == 400
    assert "made_up_kpi" in str(resp.data)


@pytest.mark.django_db
def test_patch_rejects_invalid_aggregation_policy(owner: object, hybrid_program: Program) -> None:
    resp = _client(owner).patch(
        _url(hybrid_program),
        {"aggregation_policy": "totally_made_up"},
        format="json",
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_patch_dedupes_repeated_kpis(owner: object, hybrid_program: Program) -> None:
    resp = _client(owner).patch(
        _url(hybrid_program),
        {"enabled_kpis": ["schedule_health", "schedule_health", "critical_tasks"]},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["enabled_kpis"] == ["schedule_health", "critical_tasks"]


@pytest.mark.django_db
def test_patch_rejects_oversized_kpi_list(owner: object, hybrid_program: Program) -> None:
    # Security M1 (#527): the ListField caps length at 64 — much larger than
    # the closed enum so legitimate use is unaffected, but an attacker cannot
    # blow up the validator's error message by sending many bad values.
    payload = {"enabled_kpis": ["schedule_health"] * 1000}
    resp = _client(owner).patch(_url(hybrid_program), payload, format="json")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Partial PATCH (one field at a time)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_only_enabled_kpis_leaves_policy_unchanged(
    owner: object, hybrid_program: Program
) -> None:
    initial = _client(owner).get(_url(hybrid_program)).data
    resp = _client(owner).patch(
        _url(hybrid_program),
        {"enabled_kpis": ["schedule_health"]},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["enabled_kpis"] == ["schedule_health"]
    assert resp.data["aggregation_policy"] == initial["aggregation_policy"]


@pytest.mark.django_db
def test_patch_only_policy_leaves_kpis_unchanged(owner: object, hybrid_program: Program) -> None:
    initial = _client(owner).get(_url(hybrid_program)).data
    resp = _client(owner).patch(
        _url(hybrid_program),
        {"aggregation_policy": "weighted_by_budget"},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["aggregation_policy"] == "weighted_by_budget"
    assert resp.data["enabled_kpis"] == initial["enabled_kpis"]


# ---------------------------------------------------------------------------
# Audit trail (HistoricalRecords on Program)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_creates_history_row(owner: object, hybrid_program: Program) -> None:
    before = hybrid_program.history.count()
    resp = _client(owner).patch(
        _url(hybrid_program),
        {"aggregation_policy": "average"},
        format="json",
    )
    assert resp.status_code == 200
    hybrid_program.refresh_from_db()
    after = hybrid_program.history.count()
    assert after > before, "PATCH must create a HistoricalProgram row for audit"
    latest = hybrid_program.history.first()
    assert latest.rollup_aggregation_policy == "average"


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_unauthenticated_caller_rejected(hybrid_program: Program) -> None:
    resp = APIClient().get(_url(hybrid_program))
    assert resp.status_code in (401, 403)
