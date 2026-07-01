"""Tests for the minimal ApiToken.scopes read-only-MCP slice (ADR-0186 §E, #601).

Covers the six behaviors the slice must guarantee:

  * backfill/default outcome — every token defaults to ``legacy:full`` so
    pre-scopes tokens keep unrestricted write behavior;
  * an ``mcp:read`` token can GET a wrapped read viewset but is rejected on any
    write (safe-methods guard + fail-closed write-path scope check);
  * a ``legacy:full`` token retains write access at the inbound task-sync path;
  * the ``TokenHasScope`` factory and ``TokenReadOnlyMethods`` guard in isolation
    (matching scope passes, missing scope rejects, ``legacy:full`` is a read
    superset but never substitutes for itself, non-token auth always passes);
  * human JWT/Session callers are unaffected by the additive token guards;
  * the token-create serializer accepts, validates, defaults, and read-only
    exposes ``scopes``.

The migration's RunPython backfill is deliberately *not* imported (migration
discipline rule #3 — never couple the suite to migration file names); the
equivalent outcome is asserted on the model default and via an end-to-end write.
"""

from __future__ import annotations

import secrets
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APIRequestFactory

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import TokenHasScope, TokenReadOnlyMethods
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_LEGACY_FULL,
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Project,
    _default_api_token_scopes,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="tok_owner", password="pw")


@pytest.fixture
def project(calendar: Calendar, owner: Any) -> Project:
    proj = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    # Owner role satisfies every RBAC read/write gate, so a 403 on a token
    # request can only come from the scope guards — not from a missing role.
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    return proj


def _mint(project: Project, creator: Any, scopes: list[str] | None = None) -> tuple[ApiToken, str]:
    """Create a token row with a known raw value so tests can hit endpoints."""
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    kwargs: dict[str, Any] = {}
    if scopes is not None:
        kwargs["scopes"] = scopes
    token = ApiToken.objects.create(
        project=project,
        name="test-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=creator,
        **kwargs,
    )
    return token, raw


def _bearer(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


# ---------------------------------------------------------------------------
# Backfill / default outcome
# ---------------------------------------------------------------------------


def test_default_scope_callable_returns_legacy_full() -> None:
    # The AddField default and migration backfill both stamp legacy:full onto
    # existing rows; the callable is the single source of that value.
    assert _default_api_token_scopes() == [SCOPE_LEGACY_FULL]


def test_default_scope_callable_returns_a_fresh_list() -> None:
    # A callable (not a shared literal) so no two tokens alias one mutable list.
    assert _default_api_token_scopes() is not _default_api_token_scopes()


@pytest.mark.django_db
def test_token_minted_without_scopes_defaults_to_legacy_full(project: Project, owner: Any) -> None:
    token, _ = _mint(project, owner)
    assert token.scopes == [SCOPE_LEGACY_FULL]


# ---------------------------------------------------------------------------
# mcp:read token — read allowed, write rejected
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_mcp_read_token_can_get_project(project: Project, owner: Any) -> None:
    _, raw = _mint(project, owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200, resp.data
    assert str(resp.data["id"]) == str(project.pk)


@pytest.mark.django_db
def test_mcp_read_token_cannot_patch_project(project: Project, owner: Any) -> None:
    # Owner-created token: RBAC (IsProjectScheduler) would pass, so a 403 here
    # proves TokenReadOnlyMethods blocks the non-safe method, not the role gate.
    _, raw = _mint(project, owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).patch(
        f"/api/v1/projects/{project.pk}/", {"name": "hijacked"}, format="json"
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_mcp_read_token_rejected_at_task_sync_write(project: Project, owner: Any) -> None:
    # The inbound write path fail-closes: mcp:read never satisfies legacy:full.
    _, raw = _mint(project, owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "Issue 1"},
        format="json",
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# legacy:full token — write retained
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_legacy_full_token_retains_task_sync_write(project: Project, owner: Any) -> None:
    _, raw = _mint(project, owner, scopes=[SCOPE_LEGACY_FULL])
    resp = _bearer(raw).post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {"source": "jira", "external_id": "X-1", "name": "Issue 1"},
        format="json",
    )
    assert resp.status_code == 201, resp.data


# ---------------------------------------------------------------------------
# TokenHasScope / TokenReadOnlyMethods in isolation
# ---------------------------------------------------------------------------


def _req(method: str = "get", auth: object = None) -> Any:
    request = getattr(APIRequestFactory(), method)("/")
    request.auth = auth
    return request


@pytest.mark.django_db
def test_token_has_scope_passes_when_scope_present(project: Project, owner: Any) -> None:
    token, _ = _mint(project, owner, scopes=[SCOPE_MCP_READ])
    perm = TokenHasScope(SCOPE_MCP_READ)()
    assert perm.has_permission(_req(auth=token), view=None) is True


@pytest.mark.django_db
def test_token_has_scope_rejects_when_scope_absent(project: Project, owner: Any) -> None:
    token, _ = _mint(project, owner, scopes=[SCOPE_MCP_READ])
    perm = TokenHasScope(SCOPE_LEGACY_FULL)()
    # mcp:read must NOT satisfy a required legacy:full (fail-closed write gate).
    assert perm.has_permission(_req(auth=token), view=None) is False


@pytest.mark.django_db
def test_legacy_full_is_a_read_scope_superset(project: Project, owner: Any) -> None:
    token, _ = _mint(project, owner, scopes=[SCOPE_LEGACY_FULL])
    perm = TokenHasScope(SCOPE_MCP_READ)()
    # legacy:full satisfies any read scope, so backfilled tokens can read.
    assert perm.has_permission(_req(auth=token), view=None) is True


def test_token_has_scope_passes_for_non_token_auth() -> None:
    # Human JWT/Session request (auth is not an ApiToken) always passes; RBAC
    # classes govern the human path.
    perm = TokenHasScope(SCOPE_MCP_READ)()
    assert perm.has_permission(_req(auth=None), view=None) is True


@pytest.mark.django_db
def test_read_only_methods_blocks_token_write(project: Project, owner: Any) -> None:
    token, _ = _mint(project, owner, scopes=[SCOPE_MCP_READ])
    perm = TokenReadOnlyMethods()
    assert perm.has_permission(_req("get", auth=token), view=None) is True
    assert perm.has_permission(_req("post", auth=token), view=None) is False


def test_read_only_methods_passes_for_non_token_auth() -> None:
    perm = TokenReadOnlyMethods()
    # Human write request is unaffected by the token-only guard.
    assert perm.has_permission(_req("post", auth=None), view=None) is True


# ---------------------------------------------------------------------------
# Human JWT/Session callers are unaffected
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_human_session_can_read_wrapped_view(project: Project, owner: Any) -> None:
    client = APIClient()
    client.force_authenticate(user=owner)
    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200, resp.data


@pytest.mark.django_db
def test_human_session_can_still_write_wrapped_view(project: Project, owner: Any) -> None:
    # The additive token guards must not block a human owner's legitimate write.
    client = APIClient()
    client.force_authenticate(user=owner)
    resp = client.patch(f"/api/v1/projects/{project.pk}/", {"name": "Renamed"}, format="json")
    assert resp.status_code == 200, resp.data


# ---------------------------------------------------------------------------
# Token-create serializer accepts / validates / exposes scopes
# ---------------------------------------------------------------------------


@pytest.fixture
def admin_client(project: Project) -> APIClient:
    admin = User.objects.create_user(username="tok_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=admin)
    return client


def _tokens_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/api-tokens/"


@pytest.mark.django_db
def test_create_token_with_mcp_read_scope(admin_client: APIClient, project: Project) -> None:
    resp = admin_client.post(
        _tokens_url(project), {"name": "MCP", "scopes": ["mcp:read"]}, format="json"
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["scopes"] == [SCOPE_MCP_READ]
    token = ApiToken.objects.get(pk=resp.data["id"])
    assert token.scopes == [SCOPE_MCP_READ]


@pytest.mark.django_db
def test_create_token_without_scopes_defaults_to_legacy_full(
    admin_client: APIClient, project: Project
) -> None:
    resp = admin_client.post(_tokens_url(project), {"name": "CI"}, format="json")
    assert resp.status_code == 201, resp.data
    assert resp.data["scopes"] == [SCOPE_LEGACY_FULL]


@pytest.mark.django_db
def test_create_token_empty_scopes_collapses_to_legacy_full(
    admin_client: APIClient, project: Project
) -> None:
    resp = admin_client.post(_tokens_url(project), {"name": "CI", "scopes": []}, format="json")
    assert resp.status_code == 201, resp.data
    assert resp.data["scopes"] == [SCOPE_LEGACY_FULL]


@pytest.mark.django_db
def test_create_token_dedupes_scopes(admin_client: APIClient, project: Project) -> None:
    resp = admin_client.post(
        _tokens_url(project),
        {"name": "CI", "scopes": ["mcp:read", "mcp:read"]},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["scopes"] == [SCOPE_MCP_READ]


@pytest.mark.django_db
def test_create_token_invalid_scope_rejected(admin_client: APIClient, project: Project) -> None:
    resp = admin_client.post(
        _tokens_url(project), {"name": "CI", "scopes": ["god:mode"]}, format="json"
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_scopes_are_read_only_on_token_detail(admin_client: APIClient, project: Project) -> None:
    created = admin_client.post(
        _tokens_url(project), {"name": "MCP", "scopes": ["mcp:read"]}, format="json"
    )
    token_id = created.data["id"]
    # scopes surface on the read serializer (immutable after mint).
    resp = admin_client.get(f"{_tokens_url(project)}{token_id}/")
    assert resp.status_code == 200
    assert resp.data["scopes"] == [SCOPE_MCP_READ]
