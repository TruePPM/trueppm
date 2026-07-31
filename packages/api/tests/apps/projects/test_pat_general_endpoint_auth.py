"""Personal Access Tokens on the *general* endpoint surface (#2547).

Before this fix, ``ProjectApiTokenAuthentication`` was never wired into
``DEFAULT_AUTHENTICATION_CLASSES``, and the only two views that referenced it
directly (``TaskSyncView``, the acceptance-result ingest view) both additionally
require ``IsTokenForProject`` — which an owner-scoped Personal Access Token
(``project=None``, ``program=None``) can never satisfy. A minted PAT therefore had
no endpoint to authenticate against at all, contradicting ADR-0214's description of
a PAT as a credential that "acts as that user" the way a JWT/session would.

``OwnerScopedApiTokenAuthentication`` (wired into ``DEFAULT_AUTHENTICATION_CLASSES``
in ``settings/base.py`` and ``settings/dev.py``) closes that gap for the general
surface:

  * an owner-scoped token carrying ``legacy:full`` now authenticates like a
    JWT/session request would, so ordinary RBAC on ``request.user`` governs it
    (read *and* write; no privilege elevation over the owner's own session);
  * a project- or program-scoped token is rejected on this surface — its
    ``request.user`` resolves to the *minter*, not itself, so accepting it here
    would let a narrow integration credential act with the minter's full
    account-wide authority (the confused-deputy widening this fix must not
    introduce). It keeps authenticating exactly as before via the narrow surfaces
    that reference the base ``ProjectApiTokenAuthentication`` directly
    (``TaskSyncView``, the acceptance-result view);
  * an owner-scoped ``mcp:read``-only token is also rejected here — it stays
    confined to the curated MCP-readable viewset list (``TokenReadOnlyMethods`` +
    ``TokenHasScope``), unaffected by this change.
"""

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
from trueppm_api.apps.projects.models import SCOPE_MCP_READ, ApiToken, Calendar, Program, Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(
        username="pat_owner", email="pat_owner@example.com", password="pw"
    )


@pytest.fixture
def project(calendar: Calendar, owner: Any) -> Project:
    proj = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    # MEMBER (not admin) — proves the PAT does not elevate its owner's role.
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.MEMBER)
    return proj


def _mint_personal(owner: Any, scopes: list[str] | None = None) -> tuple[ApiToken, str]:
    """Create an owner-scoped (personal) token with a known raw value."""
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


def _mint_project_scoped(
    project: Project, creator: Any, scopes: list[str] | None = None
) -> tuple[ApiToken, str]:
    """Create a project-scoped integration token (never accepted on this surface)."""
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    kwargs: dict[str, Any] = {}
    if scopes is not None:
        kwargs["scopes"] = scopes
    token = ApiToken.objects.create(
        project=project,
        name="integration-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=creator,
        **kwargs,
    )
    return token, raw


def _mint_program_scoped(
    program: Program, creator: Any, scopes: list[str] | None = None
) -> tuple[ApiToken, str]:
    """Create a program-scoped integration token (never accepted on this surface)."""
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    kwargs: dict[str, Any] = {}
    if scopes is not None:
        kwargs["scopes"] = scopes
    token = ApiToken.objects.create(
        program=program,
        name="integration-token",
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
# Personal (owner-scoped, legacy:full) PAT authenticates broadly
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_personal_token_reads_profile_endpoint(owner: Any) -> None:
    """GET /api/v1/auth/me/profile/ — a general, non-project, non-MCP endpoint.

    This is the exact "no endpoint to use it against" gap from #2547: previously
    a full-access PAT could not reach any general endpoint at all.
    """
    _, raw = _mint_personal(owner)
    resp = _bearer(raw).get("/api/v1/auth/me/profile/")
    assert resp.status_code == 200, resp.data


@pytest.mark.django_db
def test_personal_token_writes_profile_endpoint(owner: Any) -> None:
    """PATCH the same endpoint proves general *write* access, not just read."""
    _, raw = _mint_personal(owner)
    resp = _bearer(raw).patch(
        "/api/v1/auth/me/profile/", {"default_landing": "my_work"}, format="json"
    )
    assert resp.status_code == 200, resp.data
    assert resp.data["default_landing"] == "my_work"


@pytest.mark.django_db
def test_personal_token_reads_calendar_list(owner: Any, calendar: Calendar) -> None:
    """GET /api/v1/calendars/ — a general, non-MCP-wrapped ModelViewSet."""
    _, raw = _mint_personal(owner)
    resp = _bearer(raw).get("/api/v1/calendars/")
    assert resp.status_code == 200, resp.data


@pytest.mark.django_db
def test_personal_token_write_still_governed_by_ordinary_rbac(owner: Any) -> None:
    """A PAT acts strictly as its owner — RBAC still applies, no privilege elevation.

    `owner` holds no ADMIN/OWNER project membership anywhere, so IsOrgAdmin denies
    the write exactly as it would for the same user's own JWT session.
    """
    _, raw = _mint_personal(owner)
    resp = _bearer(raw).post("/api/v1/calendars/", {"name": "New Calendar"}, format="json")
    assert resp.status_code == 403, resp.data


@pytest.mark.django_db
def test_personal_token_write_succeeds_when_owner_has_admin_role(calendar: Calendar) -> None:
    """The flip side: an admin owner's PAT can write, exactly as their own session
    would — proving the fix grants real general write access, not merely reads."""
    admin_owner = User.objects.create_user(username="pat_admin", password="pw")
    proj = Project.objects.create(name="AdminProj", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=proj, user=admin_owner, role=Role.ADMIN)
    _, raw = _mint_personal(admin_owner)
    resp = _bearer(raw).post("/api/v1/calendars/", {"name": "New Calendar"}, format="json")
    assert resp.status_code == 201, resp.data


@pytest.mark.django_db
def test_personal_token_with_far_future_expiry_still_authenticates(owner: Any) -> None:
    _, raw = _mint_personal(owner)
    token = ApiToken.objects.get(owner=owner)
    token.expires_at = timezone.now() + timedelta(days=1)
    token.save(update_fields=["expires_at"])
    resp = _bearer(raw).get("/api/v1/auth/me/profile/")
    assert resp.status_code == 200, resp.data


@pytest.mark.django_db
def test_expired_personal_token_rejected_on_general_endpoint(owner: Any) -> None:
    _, raw = _mint_personal(owner)
    token = ApiToken.objects.get(owner=owner)
    token.expires_at = timezone.now() - timedelta(minutes=1)
    token.save(update_fields=["expires_at"])
    resp = _bearer(raw).get("/api/v1/auth/me/profile/")
    assert resp.status_code == 401, resp.data


@pytest.mark.django_db
def test_revoked_personal_token_rejected_on_general_endpoint(owner: Any) -> None:
    _, raw = _mint_personal(owner)
    token = ApiToken.objects.get(owner=owner)
    token.revoked_at = timezone.now()
    token.save(update_fields=["revoked_at"])
    resp = _bearer(raw).get("/api/v1/auth/me/profile/")
    assert resp.status_code == 401, resp.data


# ---------------------------------------------------------------------------
# No over-widening: project/program tokens and mcp:read-only PATs are rejected
# on the general surface (the rbac-check concern for #2547)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_scoped_token_rejected_on_general_endpoint(project: Project, owner: Any) -> None:
    """A project-scoped integration token must NOT gain the minter's full
    account-wide authority on a general endpoint — the confused-deputy widening
    this fix must not introduce."""
    _, raw = _mint_project_scoped(project, owner)
    resp = _bearer(raw).get("/api/v1/auth/me/profile/")
    assert resp.status_code == 401, resp.data


@pytest.mark.django_db
def test_program_scoped_token_rejected_on_general_endpoint(owner: Any) -> None:
    program = Program.objects.create(name="Prog")
    _, raw = _mint_program_scoped(program, owner)
    resp = _bearer(raw).get("/api/v1/auth/me/profile/")
    assert resp.status_code == 401, resp.data


@pytest.mark.django_db
def test_mcp_read_only_personal_token_rejected_on_general_endpoint(owner: Any) -> None:
    """An mcp:read-only PAT stays confined to the curated MCP-readable surface —
    it must not gain broader access (read *or* write) via the general surface."""
    _, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get("/api/v1/auth/me/profile/")
    assert resp.status_code == 401, resp.data


@pytest.mark.django_db
def test_mcp_read_only_personal_token_still_works_on_mcp_surface(owner: Any) -> None:
    """Regression guard: the mcp:read surface itself (via the base
    ProjectApiTokenAuthentication, prepended by McpReadableViewMixin) is untouched
    by this change."""
    _, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get("/api/v1/projects/")
    assert resp.status_code == 200, resp.data


# ---------------------------------------------------------------------------
# Regression: the narrow write surfaces project/program tokens were designed
# for are unaffected (they authenticate via the base class directly, not this
# subclass)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_project_scoped_token_still_works_on_task_sync(project: Project, owner: Any) -> None:
    _, raw = _mint_project_scoped(project, owner)
    resp = _bearer(raw).post(
        f"/api/v1/projects/{project.pk}/task-sync/",
        {
            "source": "jira",
            "external_id": "JIRA-1",
            "title": "External task",
            "status": "todo",
        },
        format="json",
    )
    assert resp.status_code in (200, 201), resp.data


@pytest.mark.django_db
def test_no_auth_header_rejected_on_general_endpoint() -> None:
    resp = APIClient().get("/api/v1/auth/me/profile/")
    assert resp.status_code == 401
