"""Self-service token revocation must not re-date or double-audit a racing revoke (#4580)."""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    ApiToken,
    ApiTokenAuditAction,
    ApiTokenAuditEntry,
    Calendar,
    Project,
)
from trueppm_api.apps.projects.views import MyApiTokenViewSet, ProjectApiTokenViewSet

User = get_user_model()


def _mint(**kwargs: Any) -> ApiToken:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    return ApiToken.objects.create(
        name="t",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        **kwargs,
    )


def _revoke_after_read(monkeypatch: pytest.MonkeyPatch, viewset: type, when: Any) -> None:
    """Revoke the row right after ``get_object`` returns, so the view holds a stale copy."""
    real = viewset.get_object  # type: ignore[attr-defined]

    def racing(self: Any) -> Any:
        token = real(self)
        ApiToken.objects.filter(pk=token.pk).update(revoked_at=when)
        ApiTokenAuditEntry.objects.create(
            owner=token.owner,
            project=token.project,
            token=token,
            token_prefix=token.token_prefix,
            action=ApiTokenAuditAction.REVOKED.value,
            detail={"reason": "other_path"},
        )
        return token

    monkeypatch.setattr(viewset, "get_object", racing)


@pytest.mark.django_db
def test_personal_destroy_keeps_original_revoked_at_and_single_audit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = User.objects.create_user(username="u", password="pw")
    token = _mint(owner=user, created_by=user)
    original = timezone.now() - timedelta(hours=2)
    _revoke_after_read(monkeypatch, MyApiTokenViewSet, original)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.delete(f"/api/v1/me/api-tokens/{token.pk}/")

    assert resp.status_code == 204
    token.refresh_from_db()
    assert token.revoked_at == original
    assert ApiTokenAuditEntry.objects.filter(token=token).count() == 1


@pytest.mark.django_db
def test_personal_destroy_normal_path_still_audits_once() -> None:
    user = User.objects.create_user(username="u", password="pw")
    token = _mint(owner=user, created_by=user)
    client = APIClient()
    client.force_authenticate(user=user)

    assert client.delete(f"/api/v1/me/api-tokens/{token.pk}/").status_code == 204
    assert client.delete(f"/api/v1/me/api-tokens/{token.pk}/").status_code == 204

    token.refresh_from_db()
    assert token.revoked_at is not None
    assert ApiTokenAuditEntry.objects.filter(token=token).count() == 1


@pytest.mark.django_db
def test_project_destroy_keeps_original_revoked_at_and_single_audit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = User.objects.create_user(username="adm", password="pw")
    project = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="Std")
    )
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    token = _mint(project=project, created_by=admin)
    original = timezone.now() - timedelta(hours=2)
    _revoke_after_read(monkeypatch, ProjectApiTokenViewSet, original)
    client = APIClient()
    client.force_authenticate(user=admin)

    resp = client.delete(f"/api/v1/projects/{project.pk}/api-tokens/{token.pk}/")

    assert resp.status_code == 204
    token.refresh_from_db()
    assert token.revoked_at == original
    assert ApiTokenAuditEntry.objects.filter(token=token).count() == 1
