"""Tests for the MCP administration controls (#2021, ADR-0497).

Covers the four operator-facing controls:

  * ``TRUEPPM_MCP_ENABLED`` instance kill switch — an MCP-scoped token is denied
    (403) when the switch is off and allowed (200) when on, while a human
    JWT/session request on the same viewset is UNAFFECTED either way;
  * the ``McpInstanceEnabled`` permission in isolation (non-token auth always
    passes; a token is denied only when the switch is off);
  * the env-overridable caps actually take effect under ``override_settings`` —
    the personal-token cap, the token-issuance throttle limit, and the task-sync
    backfill/steady-state limits.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient, APIRequestFactory

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import McpInstanceEnabled
from trueppm_api.apps.projects import throttles
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Project,
)
from trueppm_api.apps.projects.throttles import TokenIssuanceThrottle, _task_sync_limit

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="mcp_owner", password="pw")


@pytest.fixture
def project(calendar: Calendar, owner: Any) -> Project:
    proj = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    # Owner role satisfies every RBAC gate, so a 403 on a token request can only
    # come from the MCP switch — not from a missing role.
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    return proj


def _mint_personal(owner: Any, scopes: list[str] | None = None) -> tuple[ApiToken, str]:
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
# (1) Instance-wide MCP disable switch — end-to-end
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@override_settings(TRUEPPM_MCP_ENABLED=True)
def test_mcp_token_allowed_when_switch_on(project: Project, owner: Any) -> None:
    _, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200, resp.data


@pytest.mark.django_db
@override_settings(TRUEPPM_MCP_ENABLED=False)
def test_mcp_token_denied_when_switch_off(project: Project, owner: Any) -> None:
    # Fail-closed: the token exists and carries mcp:read, but the operator has cut
    # agent access instance-wide, so the read is refused with a 403.
    _, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 403, resp.data


@pytest.mark.django_db
@override_settings(TRUEPPM_MCP_ENABLED=False)
def test_human_session_unaffected_when_switch_off(project: Project, owner: Any) -> None:
    # The switch gates the MCP-token path ONLY. A human owner's session read on the
    # same viewset must still succeed with the switch off.
    client = APIClient()
    client.force_authenticate(user=owner)
    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200, resp.data


@pytest.mark.django_db
@override_settings(TRUEPPM_MCP_ENABLED=False)
def test_human_session_can_still_write_when_switch_off(project: Project, owner: Any) -> None:
    # A human write is likewise untouched by the MCP kill switch.
    client = APIClient()
    client.force_authenticate(user=owner)
    resp = client.patch(f"/api/v1/projects/{project.pk}/", {"name": "Renamed"}, format="json")
    assert resp.status_code == 200, resp.data


# ---------------------------------------------------------------------------
# McpInstanceEnabled permission in isolation
# ---------------------------------------------------------------------------


def _req(method: str = "get", auth: object = None) -> Any:
    request = getattr(APIRequestFactory(), method)("/")
    request.auth = auth
    return request


def test_mcp_instance_enabled_passes_for_non_token_auth() -> None:
    # Human JWT/Session request (auth is not an ApiToken) always passes, regardless
    # of the switch — RBAC classes govern the human path.
    perm = McpInstanceEnabled()
    with override_settings(TRUEPPM_MCP_ENABLED=False):
        assert perm.has_permission(_req(auth=None), view=None) is True


@pytest.mark.django_db
def test_mcp_instance_enabled_denies_token_when_off(owner: Any) -> None:
    token, _ = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    perm = McpInstanceEnabled()
    with override_settings(TRUEPPM_MCP_ENABLED=False):
        assert perm.has_permission(_req(auth=token), view=None) is False
    with override_settings(TRUEPPM_MCP_ENABLED=True):
        assert perm.has_permission(_req(auth=token), view=None) is True


# ---------------------------------------------------------------------------
# (3) Env-overridable caps
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@override_settings(TRUEPPM_MAX_PERSONAL_ACCESS_TOKENS=2)
def test_personal_token_cap_honors_setting(owner: Any) -> None:
    # Default cap is 10; overriding to 2 must make the third mint fail, proving the
    # enforced value is read from settings and not the module constant.
    client = APIClient()
    client.force_authenticate(user=owner)
    _mint_personal(owner)
    _mint_personal(owner)
    resp = client.post("/api/v1/me/api-tokens/", {"name": "one too many"}, format="json")
    assert resp.status_code == 400, resp.data
    assert "2" in resp.data["detail"]


@pytest.mark.django_db
@override_settings(TRUEPPM_MAX_PERSONAL_ACCESS_TOKENS=3)
def test_personal_token_cap_raised_allows_more(owner: Any) -> None:
    client = APIClient()
    client.force_authenticate(user=owner)
    _mint_personal(owner)
    _mint_personal(owner)
    # Two active tokens, cap of 3 → the third mint succeeds.
    resp = client.post("/api/v1/me/api-tokens/", {"name": "third"}, format="json")
    assert resp.status_code == 201, resp.data


class _FakeRedis:
    """Minimal stand-in for the ``incr``/``expire`` calls the throttle issues."""

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}

    def incr(self, key: str) -> int:
        self._counts[key] = self._counts.get(key, 0) + 1
        return self._counts[key]

    def expire(self, _key: str, _ttl: int) -> None:
        return None


def _auth_user(pk: str = "u1") -> SimpleNamespace:
    return SimpleNamespace(pk=pk, is_authenticated=True)


def test_token_issuance_limit_honors_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    # Default USER_LIMIT is 5; overriding TRUEPPM_TOKEN_ISSUANCE_PER_MINUTE to 2 must
    # deny the third mint in the window, proving the property reads settings.
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)
    throttle = TokenIssuanceThrottle()
    request = SimpleNamespace(user=_auth_user())
    with override_settings(TRUEPPM_TOKEN_ISSUANCE_PER_MINUTE=2):
        assert throttle.user_limit == 2
        assert throttle.allow_request(request, view=None) is True
        assert throttle.allow_request(request, view=None) is True
        assert throttle.allow_request(request, view=None) is False


def test_task_sync_limit_honors_backfill_setting() -> None:
    now = timezone.now()
    fresh = now - timedelta(minutes=5)  # inside the 60-minute backfill window
    steady = now - timedelta(minutes=120)  # past the window
    with override_settings(
        TRUEPPM_TASK_SYNC_BACKFILL_LIMIT=42,
        TRUEPPM_TASK_SYNC_STEADY_STATE_LIMIT=7,
    ):
        assert _task_sync_limit(fresh, now) == 42
        assert _task_sync_limit(steady, now) == 7


def test_task_sync_limit_defaults_without_override() -> None:
    now = timezone.now()
    fresh = now - timedelta(minutes=5)
    steady = now - timedelta(minutes=120)
    assert _task_sync_limit(fresh, now) == throttles.BACKFILL_LIMIT
    assert _task_sync_limit(steady, now) == throttles.STEADY_STATE_LIMIT
