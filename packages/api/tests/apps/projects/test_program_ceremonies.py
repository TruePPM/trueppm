"""Tests for ProgramSettings → Cadence & ceremonies API (#528, ADR-0079).

Covers:
- CeremonyTemplate CRUD with the program-membership permission matrix
  (Member → list/retrieve, Admin → create/update/destroy).
- Scrum reserved-name rejection at the API layer.
- Conditional cadence_day / cadence_time required for time-of-day cadences
  and ignored for on_milestone.
- Soft-delete semantics so a name can be re-used after deletion.
- PhaseGateConfig lazy-create on first GET; Admin-only PATCH.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import (
    CeremonyTemplate,
    PhaseGateConfig,
    Program,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def stranger(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


@pytest.fixture
def program(owner: object, member: object) -> Program:
    program = Program.objects.create(name="Phase 2")
    ProgramMembership.objects.create(program=program, user=owner, role=Role.OWNER)
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    return program


def _weekly_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "Program sync",
        "cadence_type": "weekly",
        "cadence_day": "monday",
        "cadence_time": "10:00",
        "duration_minutes": 60,
        "owner_role": "Program Manager",
        "enabled": True,
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# CeremonyTemplate — list / create
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_ceremonies_empty_for_new_program(owner: object, program: Program) -> None:
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/ceremonies/")
    assert resp.status_code == 200
    # Pagination envelope or plain list — both acceptable.
    data = (
        resp.data["results"]
        if isinstance(resp.data, dict) and "results" in resp.data
        else resp.data
    )
    assert data == []


@pytest.mark.django_db
def test_create_ceremony_as_admin_succeeds(owner: object, program: Program) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(),
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["name"] == "Program sync"
    assert resp.data["cadence_type"] == "weekly"
    assert resp.data["cadence_day"] == "monday"
    assert resp.data["cadence_time"].startswith("10:00")
    assert resp.data["duration_minutes"] == 60
    assert resp.data["owner_role"] == "Program Manager"
    assert resp.data["enabled"] is True
    assert resp.data["server_version"] >= 1
    assert CeremonyTemplate.objects.filter(program=program).count() == 1


@pytest.mark.django_db
def test_create_ceremony_as_member_forbidden(member: object, program: Program) -> None:
    resp = _client(member).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(),
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_create_ceremony_as_stranger_forbidden(stranger: object, program: Program) -> None:
    resp = _client(stranger).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(),
        format="json",
    )
    # The program-membership permission classes wrap missing membership in
    # 403 (PermissionDenied), not 404, because the URL path is otherwise valid.
    assert resp.status_code == 403


@pytest.mark.django_db
def test_unauthenticated_list_is_rejected(program: Program) -> None:
    resp = APIClient().get(f"/api/v1/programs/{program.pk}/ceremonies/")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Scrum reserved-name validation (Morgan/Alex VoC blocker)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "Sprint Planning",
        "sprint planning",
        "  Sprint Review  ",  # whitespace + casefold
        "Retrospective",
        "retro",
        "Daily Scrum",
        "Standup",
        "Daily Standup",
        "Scrum of Scrums",
    ],
)
@pytest.mark.django_db
def test_create_ceremony_rejects_scrum_reserved_names(
    owner: object, program: Program, name: str
) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(name=name),
        format="json",
    )
    assert resp.status_code == 400
    assert "name" in resp.data
    body = str(resp.data["name"]).lower()
    assert "sprint" in body or "per-sprint" in body


@pytest.mark.django_db
def test_create_ceremony_accepts_program_level_names(owner: object, program: Program) -> None:
    # Names that share Scrum prefixes but aren't reserved should pass.
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(name="Sprint cadence sync"),
        format="json",
    )
    assert resp.status_code == 201


# ---------------------------------------------------------------------------
# Cadence-type conditional validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_on_milestone_clears_day_and_time(owner: object, program: Program) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(
            name="Phase gate",
            cadence_type="on_milestone",
            # Client may still send these — server should ignore.
            cadence_day="monday",
            cadence_time="10:00",
        ),
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["cadence_day"] == ""
    assert resp.data["cadence_time"] is None


@pytest.mark.django_db
def test_weekly_requires_day(owner: object, program: Program) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(cadence_day=""),
        format="json",
    )
    assert resp.status_code == 400
    assert "cadence_day" in resp.data


@pytest.mark.django_db
def test_weekly_requires_time(owner: object, program: Program) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(cadence_time=None),
        format="json",
    )
    assert resp.status_code == 400
    assert "cadence_time" in resp.data


@pytest.mark.django_db
def test_monthly_accepts_ordinal_weekday(owner: object, program: Program) -> None:
    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(
            name="Steering committee",
            cadence_type="monthly",
            cadence_day="1st-thursday",
            cadence_time="14:00",
            duration_minutes=90,
        ),
        format="json",
    )
    assert resp.status_code == 201
    assert resp.data["cadence_day"] == "1st-thursday"


@pytest.mark.django_db
def test_duration_out_of_range_rejected(owner: object, program: Program) -> None:
    for bad in (0, 4, 1441, -10):
        resp = _client(owner).post(
            f"/api/v1/programs/{program.pk}/ceremonies/",
            _weekly_payload(duration_minutes=bad),
            format="json",
        )
        assert resp.status_code == 400, (bad, resp.content)


# ---------------------------------------------------------------------------
# Toggle enabled (inline PATCH)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_admin_can_toggle_enabled(owner: object, program: Program) -> None:
    create = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(),
        format="json",
    )
    ceremony_id = create.data["id"]
    initial_version = create.data["server_version"]

    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/ceremonies/{ceremony_id}/",
        {"enabled": False},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["enabled"] is False
    assert resp.data["server_version"] > initial_version


@pytest.mark.django_db
def test_member_cannot_toggle_enabled(owner: object, member: object, program: Program) -> None:
    create = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(),
        format="json",
    )
    ceremony_id = create.data["id"]
    resp = _client(member).patch(
        f"/api/v1/programs/{program.pk}/ceremonies/{ceremony_id}/",
        {"enabled": False},
        format="json",
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Delete — soft-delete enables name reuse
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_admin_can_soft_delete(owner: object, program: Program) -> None:
    create = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(),
        format="json",
    )
    ceremony_id = create.data["id"]
    resp = _client(owner).delete(f"/api/v1/programs/{program.pk}/ceremonies/{ceremony_id}/")
    assert resp.status_code == 204
    obj = CeremonyTemplate.objects.get(pk=ceremony_id)
    assert obj.is_deleted is True
    # Row no longer appears in the list response.
    list_resp = _client(owner).get(f"/api/v1/programs/{program.pk}/ceremonies/")
    data = (
        list_resp.data["results"]
        if isinstance(list_resp.data, dict) and "results" in list_resp.data
        else list_resp.data
    )
    assert all(c["id"] != ceremony_id for c in data)


@pytest.mark.django_db
def test_soft_deleted_name_can_be_reused(owner: object, program: Program) -> None:
    first = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(),
        format="json",
    )
    _client(owner).delete(f"/api/v1/programs/{program.pk}/ceremonies/{first.data['id']}/")
    # Same name should now succeed because the partial unique constraint
    # excludes soft-deleted rows.
    second = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(),
        format="json",
    )
    assert second.status_code == 201, second.content
    assert second.data["id"] != first.data["id"]


@pytest.mark.django_db
def test_member_cannot_delete(owner: object, member: object, program: Program) -> None:
    create = _client(owner).post(
        f"/api/v1/programs/{program.pk}/ceremonies/",
        _weekly_payload(),
        format="json",
    )
    resp = _client(member).delete(f"/api/v1/programs/{program.pk}/ceremonies/{create.data['id']}/")
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# PhaseGateConfig — singleton
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_phase_gate_config_lazy_created_on_first_get(owner: object, program: Program) -> None:
    assert not PhaseGateConfig.objects.filter(program=program).exists()
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/phase-gate-config/")
    assert resp.status_code == 200
    assert resp.data["enabled"] is False
    assert resp.data["invite_template"] == ""
    assert PhaseGateConfig.objects.filter(program=program).count() == 1


@pytest.mark.django_db
def test_phase_gate_config_member_can_read(member: object, program: Program) -> None:
    resp = _client(member).get(f"/api/v1/programs/{program.pk}/phase-gate-config/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_phase_gate_config_member_cannot_patch(member: object, program: Program) -> None:
    resp = _client(member).patch(
        f"/api/v1/programs/{program.pk}/phase-gate-config/",
        {"enabled": True},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_phase_gate_config_admin_can_patch(owner: object, program: Program) -> None:
    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/phase-gate-config/",
        {"enabled": True, "invite_template": "Subject: Gate review - {{milestone.name}}"},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["enabled"] is True
    assert "Gate review" in resp.data["invite_template"]


@pytest.mark.django_db
def test_phase_gate_config_stranger_forbidden(stranger: object, program: Program) -> None:
    resp = _client(stranger).get(f"/api/v1/programs/{program.pk}/phase-gate-config/")
    assert resp.status_code in (403, 404)
