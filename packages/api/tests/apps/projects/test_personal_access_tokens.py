"""Tests for user-scoped Personal Access Tokens (ADR-0214, issue #648).

Covers MyApiTokenViewSet at ``/api/v1/me/api-tokens/`` (create with one-time
reveal, the 10-active-token cap, expiry-aware "active" accounting, owner-scoped
revoke, and per-user isolation), the three-way scope XOR at the database layer,
and the guarantee that personal tokens never leak into the project/program token
list. The authenticator's owner-resolution + expiry filter and the
password-change revocation are covered in test_api_token_auth.py and the access
password-reset tests respectively.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    MAX_PERSONAL_ACCESS_TOKENS,
    ApiToken,
    ApiTokenAuditEntry,
    Calendar,
    Program,
    Project,
)

User = get_user_model()

_URL = "/api/v1/me/api-tokens/"


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _mint_personal(owner: object, *, name: str = "PAT", **kwargs: object) -> ApiToken:
    """Mint an active personal token directly (bypassing the viewset)."""
    raw = TOKEN_PREFIX + secrets.token_hex(32)  # unique 64-hex body per call
    return ApiToken.objects.create(
        owner=owner,
        name=name,
        scopes=["legacy:full"],
        token_prefix=raw[len(TOKEN_PREFIX) :][:8],
        token_hash=sha256_hex(raw),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Create — one-time reveal, owner auto-scoping, MINTED audit
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_returns_raw_token_once_and_auto_scopes_owner(
    client: APIClient, user: object
) -> None:
    resp = client.post(_URL, {"name": "Power BI export"}, format="json")
    assert resp.status_code == 201, resp.data
    assert resp.data["token"].startswith("tppm_")
    assert resp.data["name"] == "Power BI export"
    # Owner is auto-scoped from request.user; the raw token / hash are never echoed.
    token = ApiToken.objects.get(pk=resp.data["id"])
    assert token.owner_id == user.pk
    assert token.project_id is None and token.program_id is None
    assert token.scopes == ["legacy:full"]
    # A MINTED audit row was written with owner scope.
    audit = ApiTokenAuditEntry.objects.get(token=token, action="minted")
    assert audit.owner_id == user.pk
    assert audit.project_id is None and audit.program_id is None


@pytest.mark.django_db
def test_token_not_retrievable_after_create(client: APIClient) -> None:
    created = client.post(_URL, {"name": "CI"}, format="json")
    token_id = created.data["id"]
    resp = client.get(f"{_URL}{token_id}/")
    assert resp.status_code == 200
    assert "token" not in resp.data
    assert resp.data["token_prefix"]


@pytest.mark.django_db
def test_create_accepts_future_expiry_and_rejects_past(client: APIClient) -> None:
    future = (timezone.now() + timedelta(days=30)).isoformat()
    ok = client.post(_URL, {"name": "expiring", "expires_at": future}, format="json")
    assert ok.status_code == 201, ok.data
    assert ok.data["expires_at"] is not None

    past = (timezone.now() - timedelta(days=1)).isoformat()
    bad = client.post(_URL, {"name": "dead", "expires_at": past}, format="json")
    assert bad.status_code == 400
    assert "expires_at" in bad.data


@pytest.mark.django_db
def test_create_requires_name(client: APIClient) -> None:
    resp = client.post(_URL, {"name": "   "}, format="json")
    assert resp.status_code == 400
    assert "name" in resp.data


@pytest.mark.django_db
def test_anonymous_cannot_create(db: object) -> None:
    resp = APIClient().post(_URL, {"name": "x"}, format="json")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# The 10-active-token cap
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_cap_blocks_eleventh_active_token(client: APIClient, user: object) -> None:
    for i in range(MAX_PERSONAL_ACCESS_TOKENS):
        _mint_personal(user, name=f"tok-{i}")
    assert ApiToken.active_personal_tokens_for(user).count() == MAX_PERSONAL_ACCESS_TOKENS
    resp = client.post(_URL, {"name": "one too many"}, format="json")
    assert resp.status_code == 400
    assert str(MAX_PERSONAL_ACCESS_TOKENS) in resp.data["detail"]
    # No token was created.
    assert ApiToken.active_personal_tokens_for(user).count() == MAX_PERSONAL_ACCESS_TOKENS


@pytest.mark.django_db
def test_revoked_token_does_not_count_toward_cap(client: APIClient, user: object) -> None:
    for i in range(MAX_PERSONAL_ACCESS_TOKENS):
        _mint_personal(user, name=f"tok-{i}")
    # Revoke one → a slot frees up → the next create succeeds.
    victim = ApiToken.objects.filter(owner=user).first()
    victim.revoked_at = timezone.now()
    victim.save(update_fields=["revoked_at"])
    resp = client.post(_URL, {"name": "reuse the slot"}, format="json")
    assert resp.status_code == 201, resp.data


@pytest.mark.django_db
def test_expired_token_does_not_count_toward_cap(client: APIClient, user: object) -> None:
    # Nine live + one already-expired = only nine ACTIVE, so a create is allowed.
    for i in range(MAX_PERSONAL_ACCESS_TOKENS - 1):
        _mint_personal(user, name=f"tok-{i}")
    _mint_personal(user, name="expired", expires_at=timezone.now() - timedelta(minutes=1))
    assert ApiToken.active_personal_tokens_for(user).count() == MAX_PERSONAL_ACCESS_TOKENS - 1
    resp = client.post(_URL, {"name": "still room"}, format="json")
    assert resp.status_code == 201, resp.data


# ---------------------------------------------------------------------------
# List / retrieve isolation + revoke
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_only_shows_own_tokens(client: APIClient, user: object) -> None:
    _mint_personal(user, name="mine")
    other = User.objects.create_user(username="bob", password="pw")
    _mint_personal(other, name="theirs")
    resp = client.get(_URL)
    assert resp.status_code == 200
    names = {row["name"] for row in resp.data["results"]}
    assert names == {"mine"}


@pytest.mark.django_db
def test_cannot_retrieve_another_users_token(client: APIClient) -> None:
    other = User.objects.create_user(username="bob", password="pw")
    theirs = _mint_personal(other, name="theirs")
    resp = client.get(f"{_URL}{theirs.pk}/")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_destroy_revokes_and_writes_audit(client: APIClient, user: object) -> None:
    tok = _mint_personal(user, name="revoke-me")
    resp = client.delete(f"{_URL}{tok.pk}/")
    assert resp.status_code == 204
    tok.refresh_from_db()
    assert tok.revoked_at is not None
    assert ApiTokenAuditEntry.objects.filter(token=tok, action="revoked", owner=user).exists()


@pytest.mark.django_db
def test_destroy_is_idempotent(client: APIClient, user: object) -> None:
    tok = _mint_personal(user, name="twice")
    first = client.delete(f"{_URL}{tok.pk}/")
    assert first.status_code == 204
    revoked_at = ApiToken.objects.get(pk=tok.pk).revoked_at
    second = client.delete(f"{_URL}{tok.pk}/")
    assert second.status_code == 204
    # revoked_at unchanged, and no duplicate REVOKED audit row.
    assert ApiToken.objects.get(pk=tok.pk).revoked_at == revoked_at
    assert ApiTokenAuditEntry.objects.filter(token=tok, action="revoked").count() == 1


@pytest.mark.django_db
def test_cannot_revoke_another_users_token(client: APIClient) -> None:
    other = User.objects.create_user(username="bob", password="pw")
    theirs = _mint_personal(other, name="theirs")
    resp = client.delete(f"{_URL}{theirs.pk}/")
    assert resp.status_code == 404
    theirs.refresh_from_db()
    assert theirs.revoked_at is None


# ---------------------------------------------------------------------------
# DB constraint — three-way scope XOR
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_db_accepts_owner_only_token(user: object) -> None:
    tok = _mint_personal(user, name="owner-only")
    assert tok.pk is not None and tok.is_personal


@pytest.mark.django_db
def test_db_rejects_mixed_owner_and_project_token(user: object) -> None:
    cal = Calendar.objects.create(name="Std")
    project = Project.objects.create(name="P", start_date=date(2026, 1, 5), calendar=cal)
    # owner + project both set violates the three-way XOR — a confused-deputy row.
    with pytest.raises(IntegrityError), transaction.atomic():
        _mint_personal(user, name="mixed", project=project)


@pytest.mark.django_db
def test_db_rejects_all_null_scope_token(user: object) -> None:
    with pytest.raises(IntegrityError), transaction.atomic():
        ApiToken.objects.create(
            name="scopeless",
            token_prefix="deadbeef",
            token_hash=sha256_hex("scopeless-none"),
        )


# ---------------------------------------------------------------------------
# Personal tokens never leak into project/program token lists
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_personal_token_absent_from_project_token_list(user: object) -> None:
    cal = Calendar.objects.create(name="Std")
    project = Project.objects.create(name="P", start_date=date(2026, 1, 5), calendar=cal)
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    # A personal token owned by the same user must not appear on the project list.
    _mint_personal(user, name="my-pat")
    client = APIClient()
    client.force_authenticate(user=user)
    resp = client.get(f"/api/v1/projects/{project.pk}/api-tokens/")
    assert resp.status_code == 200
    results = resp.data["results"] if isinstance(resp.data, dict) else resp.data
    assert all(row["name"] != "my-pat" for row in results)


@pytest.mark.django_db
def test_personal_token_absent_from_program_token_list(user: object) -> None:
    from trueppm_api.apps.access.models import ProgramMembership

    program = Program.objects.create(name="Prog")
    ProgramMembership.objects.create(program=program, user=user, role=Role.ADMIN)
    _mint_personal(user, name="my-pat")
    client = APIClient()
    client.force_authenticate(user=user)
    resp = client.get(f"/api/v1/programs/{program.pk}/api-tokens/")
    assert resp.status_code == 200
    results = resp.data["results"] if isinstance(resp.data, dict) else resp.data
    assert all(row["name"] != "my-pat" for row in results)
