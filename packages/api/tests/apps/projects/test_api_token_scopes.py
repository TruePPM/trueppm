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
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient, APIRequestFactory

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.permissions import TokenHasScope, TokenReadOnlyMethods
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_LEGACY_FULL,
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Program,
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


def _mint_personal(owner: Any, scopes: list[str] | None = None) -> tuple[ApiToken, str]:
    """Create an owner-scoped (personal) token with a known raw value.

    Personal tokens are the only kind the MCP read surface accepts (#1712); the
    token acts as its owner, so its reads are already RBAC-confined.
    """
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    kwargs: dict[str, Any] = {}
    if scopes is not None:
        kwargs["scopes"] = scopes
    token = ApiToken.objects.create(
        owner=owner,
        name="personal-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
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
def test_personal_mcp_read_token_can_get_project(project: Project, owner: Any) -> None:
    # Owner-scoped (personal) mcp:read token is the only kind the MCP read surface
    # accepts (#1712). It acts as its owner, so the owner's own project reads pass.
    _, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200, resp.data
    assert str(resp.data["id"]) == str(project.pk)


# ---------------------------------------------------------------------------
# #1731 — the two MCP tools that were dead (always 401) because their target
# views lacked McpReadableViewMixin. These conformance reads authenticate a
# personal mcp:read token end-to-end so the tools cannot silently regress to 401.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_personal_mcp_read_token_can_get_sprint_forecast(project: Project, owner: Any) -> None:
    # get_release_forecast → projects/<pk>/sprint-forecast/. Before #1731 this
    # view lacked the mixin, so ProjectApiTokenAuthentication never ran and the
    # tppm_ bearer 401'd. A personal mcp:read token (acting as its member owner)
    # must now authenticate and read the (warming-up) forecast.
    _, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/projects/{project.pk}/sprint-forecast/")
    assert resp.status_code == 200, resp.data
    assert "status" in resp.data


@pytest.mark.django_db
def test_personal_mcp_read_token_can_list_program_backlog(owner: Any) -> None:
    # list_program_backlog → programs/<program_pk>/backlog-items/. Same dead-tool
    # class as above (BacklogItemViewSet lacked the mixin). The owner is a program
    # member, so the personal mcp:read token reads the (empty) backlog, not a 401.
    program = Program.objects.create(name="Mars Program")
    ProgramMembership.objects.create(program=program, user=owner, role=Role.OWNER)
    _, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/programs/{program.pk}/backlog-items/")
    assert resp.status_code == 200, resp.data
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_mcp_read_token_cannot_create_program_backlog_item(owner: Any) -> None:
    # The additive mixin must not open the write branch: a mcp:read token is
    # confined to safe methods on every action, so a POST is rejected (the
    # TokenReadOnlyMethods guard denies it before the write RBAC gate).
    program = Program.objects.create(name="Mars Program")
    ProgramMembership.objects.create(program=program, user=owner, role=Role.OWNER)
    _, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).post(
        f"/api/v1/programs/{program.pk}/backlog-items/",
        {"title": "Should not be created", "item_type": "STORY"},
        format="json",
    )
    assert resp.status_code == 403, resp.data


# ---------------------------------------------------------------------------
# #1712 — project/program tokens are rejected on the MCP read surface;
# personal tokens are confined to the owner's own membership by RBAC.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_scoped_token_rejected_on_mcp_collection_tool(project: Project, owner: Any) -> None:
    # The confused-deputy fix: a project-scoped token carries no pk on a collection
    # tool, so without the owner-scope guard it would return every project the
    # minter can see. It must now be 401'd on the MCP read surface entirely.
    _, raw = _mint(project, owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get("/api/v1/projects/")
    assert resp.status_code == 401, resp.data


@pytest.mark.django_db
def test_project_scoped_token_rejected_on_mcp_detail(project: Project, owner: Any) -> None:
    # Even a per-project GET is refused for a project/program token — the simplest
    # correct policy is owner-only across the whole MCP read surface.
    _, raw = _mint(project, owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 401, resp.data


@pytest.mark.django_db
def test_project_token_cannot_read_second_project_via_collection(
    project: Project, owner: Any, calendar: Calendar
) -> None:
    # A token bound to `project` must not become a credential that reads a *second*
    # project the minter happens to be a member of. Owner-only rejection (401) makes
    # this structurally impossible for the token; the owner's personal token still
    # sees both, exactly as the owner's own session would.
    other = Project.objects.create(name="P2", start_date=date(2026, 4, 1), calendar=calendar)
    from trueppm_api.apps.access.models import ProjectMembership, Role

    ProjectMembership.objects.create(project=other, user=owner, role=Role.OWNER)

    _, scoped_raw = _mint(project, owner, scopes=[SCOPE_MCP_READ])
    scoped_resp = _bearer(scoped_raw).get("/api/v1/projects/")
    assert scoped_resp.status_code == 401, scoped_resp.data

    _, personal_raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    personal_resp = _bearer(personal_raw).get("/api/v1/projects/")
    assert personal_resp.status_code == 200, personal_resp.data
    ids = {str(row["id"]) for row in personal_resp.data["results"]}
    assert {str(project.pk), str(other.pk)} <= ids


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


def _future() -> str:
    """An ISO-8601 expiry a day out — mcp:read mints require a non-null future one."""
    return (timezone.now() + timedelta(days=1)).isoformat()


@pytest.mark.django_db
def test_create_token_with_mcp_read_scope(admin_client: APIClient, project: Project) -> None:
    resp = admin_client.post(
        _tokens_url(project),
        {"name": "MCP", "scopes": ["mcp:read"], "expires_at": _future()},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["scopes"] == [SCOPE_MCP_READ]
    token = ApiToken.objects.get(pk=resp.data["id"])
    assert token.scopes == [SCOPE_MCP_READ]
    assert token.expires_at is not None


@pytest.mark.django_db
def test_create_mcp_read_token_without_expiry_rejected(
    admin_client: APIClient, project: Project
) -> None:
    # #1713: an mcp:read token must expire so a leaked read credential is
    # self-limiting. Minting one with no expires_at is a 400 at mint time.
    resp = admin_client.post(
        _tokens_url(project), {"name": "MCP", "scopes": ["mcp:read"]}, format="json"
    )
    assert resp.status_code == 400, resp.data
    assert "expires_at" in resp.data


@pytest.mark.django_db
def test_create_token_without_scopes_defaults_to_legacy_full(
    admin_client: APIClient, project: Project
) -> None:
    # A legacy:full sync token is unaffected by the mcp:read expiry rule — no
    # expires_at is required and it never expires (backward-safe).
    resp = admin_client.post(_tokens_url(project), {"name": "CI"}, format="json")
    assert resp.status_code == 201, resp.data
    assert resp.data["scopes"] == [SCOPE_LEGACY_FULL]
    assert ApiToken.objects.get(pk=resp.data["id"]).expires_at is None


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
        {"name": "CI", "scopes": ["mcp:read", "mcp:read"], "expires_at": _future()},
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
        _tokens_url(project),
        {"name": "MCP", "scopes": ["mcp:read"], "expires_at": _future()},
        format="json",
    )
    token_id = created.data["id"]
    # scopes surface on the read serializer (immutable after mint).
    resp = admin_client.get(f"{_tokens_url(project)}{token_id}/")
    assert resp.status_code == 200
    assert resp.data["scopes"] == [SCOPE_MCP_READ]
