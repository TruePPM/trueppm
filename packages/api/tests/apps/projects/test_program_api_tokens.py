"""Tests for program-scoped API token CRUD (#600 pulled forward, ADR-0076).

Project-scope tokens are covered elsewhere; this covers ProgramApiTokenViewSet
at /api/v1/programs/<pk>/api-tokens/ and the program audit log, including the
ApiTokenAuditEntry program-scope extension.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import ApiToken, ApiTokenAuditEntry, Program

User = get_user_model()


@pytest.fixture
def program(db: object) -> Program:
    return Program.objects.create(name="Artemis")


@pytest.fixture
def admin_client(program: Program) -> APIClient:
    admin = User.objects.create_user(username="tok_admin", password="pw")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


@pytest.fixture
def member_client(program: Program) -> APIClient:
    member = User.objects.create_user(username="tok_member", password="pw")
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member)
    return c


def _url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/api-tokens/"


@pytest.mark.django_db
def test_program_admin_creates_token_with_one_time_reveal(
    admin_client: APIClient, program: Program
) -> None:
    resp = admin_client.post(_url(program), {"name": "Helios CI"}, format="json")
    assert resp.status_code == 201, resp.data
    # Raw token returned exactly once, prefixed tppm_.
    assert resp.data["token"].startswith("tppm_")
    assert str(resp.data["program"]) == str(program.pk)
    assert resp.data["project"] is None
    token = ApiToken.objects.get(pk=resp.data["id"])
    assert token.program_id == program.pk and token.project_id is None
    # A minted audit entry was written with program scope.
    audit = ApiTokenAuditEntry.objects.get(token=token, action="minted")
    assert audit.program_id == program.pk and audit.project_id is None


@pytest.mark.django_db
def test_token_not_retrievable_after_create(admin_client: APIClient, program: Program) -> None:
    created = admin_client.post(_url(program), {"name": "CI"}, format="json")
    token_id = created.data["id"]
    resp = admin_client.get(f"{_url(program)}{token_id}/")
    assert resp.status_code == 200
    assert "token" not in resp.data
    assert resp.data["token_prefix"]


@pytest.mark.django_db
def test_program_member_cannot_create_token(member_client: APIClient, program: Program) -> None:
    resp = member_client.post(_url(program), {"name": "CI"}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_program_member_can_list_tokens(member_client: APIClient, program: Program) -> None:
    ApiToken.objects.create(program=program, name="t", token_prefix="tppm_abc", token_hash="h" * 64)
    resp = member_client.get(_url(program))
    assert resp.status_code == 200
    assert resp.data["count"] == 1


@pytest.mark.django_db
def test_program_admin_revokes_token(admin_client: APIClient, program: Program) -> None:
    created = admin_client.post(_url(program), {"name": "CI"}, format="json")
    token_id = created.data["id"]
    resp = admin_client.delete(f"{_url(program)}{token_id}/")
    assert resp.status_code == 204
    token = ApiToken.objects.get(pk=token_id)
    assert token.revoked_at is not None
    assert ApiTokenAuditEntry.objects.filter(
        token=token, action="revoked", program=program
    ).exists()


@pytest.mark.django_db
def test_program_audit_log_lists_program_entries(admin_client: APIClient, program: Program) -> None:
    admin_client.post(_url(program), {"name": "CI"}, format="json")
    resp = admin_client.get(f"/api/v1/programs/{program.pk}/api-token-audit/")
    assert resp.status_code == 200
    actions = [row["action"] for row in resp.data["results"]]
    assert "minted" in actions
