"""Per-token rate limits on the MCP read surface (#1808 finding F4).

Every ``McpReadableViewMixin`` view is additively reachable by a personal
``mcp:read`` API token. Before #1808 those token reads were unbounded, and the
compute-heavy tools (whatif, monte-carlo/latest, forecast, sprint-forecast) each
run a CPM + Monte Carlo recompute per call — so a read-only token loop could burn
arbitrary CPU. Two throttles now bound the token caller:

* :class:`McpTokenReadThrottle` (``mcp_read``) — baseline, on every MCP-readable
  view;
* :class:`McpTokenComputeThrottle` (``mcp_read_compute``) — tighter, STACKED on
  the four compute-heavy views.

Both are no-ops for human JWT/Session traffic (``get_cache_key`` returns ``None``
for a non-token caller), which these tests pin: a session user is never 429'd by
the MCP throttles, no matter how tight the token rate is set.
"""

from __future__ import annotations

import secrets
from datetime import date
from types import SimpleNamespace
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.throttles import (
    McpTokenComputeThrottle,
    McpTokenReadThrottle,
)
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Project,
)

User = get_user_model()

_ME_URL = "/api/v1/auth/me/"


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="throttle_owner", password="pw")


@pytest.fixture
def project(owner: Any) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    proj = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    return proj


def _mint_personal(owner: Any, *, scopes: list[str] | None = None) -> str:
    """Mint an active personal token, returning its raw bearer value."""
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name="personal-token",
        scopes=scopes if scopes is not None else [SCOPE_MCP_READ],
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
    )
    return raw


def _bearer(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _set_rates(monkeypatch: pytest.MonkeyPatch, **rates: str) -> None:
    """Tighten specific MCP throttle scope rates for the duration of a test.

    ``SimpleRateThrottle.THROTTLE_RATES`` is a class attribute bound once at import
    (from ``api_settings.DEFAULT_THROTTLE_RATES``), so reassigning
    ``settings.REST_FRAMEWORK`` at test time never reaches it. Mutating that shared
    dict directly does — and ``monkeypatch.setitem`` restores the original rate when
    the test ends. Each request instantiates fresh throttles whose ``__init__``
    re-reads the rate, so the override takes effect on the next call.
    """
    for scope, rate in rates.items():
        monkeypatch.setitem(McpTokenReadThrottle.THROTTLE_RATES, scope, rate)


# ---------------------------------------------------------------------------
# Unit: get_cache_key discriminates token vs non-token callers
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_read_throttle_keys_on_token_pk(owner: Any) -> None:
    token = ApiToken.objects.create(
        owner=owner,
        name="t",
        scopes=[SCOPE_MCP_READ],
        token_prefix="abcdef01",
        token_hash=sha256_hex("x"),
        created_by=owner,
    )
    request = SimpleNamespace(auth=token)
    key = McpTokenReadThrottle().get_cache_key(request, None)  # type: ignore[arg-type]
    assert key is not None
    assert "mcp_read" in key
    assert str(token.pk) in key


def test_throttle_skips_non_token_callers() -> None:
    # A human JWT/Session request has no ApiToken in request.auth; both throttles
    # must return None (DRF reads that as "do not throttle this request").
    request = SimpleNamespace(auth=None)
    assert McpTokenReadThrottle().get_cache_key(request, None) is None  # type: ignore[arg-type]
    assert McpTokenComputeThrottle().get_cache_key(request, None) is None  # type: ignore[arg-type]
    # A stand-in for a validated JWT object (any non-ApiToken) is also skipped.
    jwt_like = SimpleNamespace(auth=object())
    assert McpTokenReadThrottle().get_cache_key(jwt_like, None) is None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Integration: baseline mcp_read throttle bounds a token on every read
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_token_read_surface_is_throttled(owner: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """A token exceeding ``mcp_read`` is 429'd on a plain metadata read."""
    cache.clear()
    try:
        _set_rates(monkeypatch, mcp_read="2/min")
        raw = _mint_personal(owner)
        client = _bearer(raw)
        statuses = [client.get(_ME_URL).status_code for _ in range(3)]
        assert statuses[:2] == [200, 200], statuses
        assert statuses[2] == 429, statuses
    finally:
        cache.clear()


@pytest.mark.django_db
def test_human_session_is_not_throttled_by_mcp_read(
    owner: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same tight ``mcp_read`` rate never touches a human session caller."""
    cache.clear()
    try:
        _set_rates(monkeypatch, mcp_read="2/min")
        client = APIClient()
        client.force_authenticate(user=owner)
        # Well past the 2/min token cap — a session user must sail through, because
        # the throttle's get_cache_key returns None for non-token auth.
        statuses = [client.get(_ME_URL).status_code for _ in range(5)]
        assert statuses == [200] * 5, statuses
    finally:
        cache.clear()


@pytest.mark.django_db
def test_two_tokens_have_independent_buckets(owner: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Each token is keyed on its own pk, so one token's cap does not starve another."""
    cache.clear()
    try:
        _set_rates(monkeypatch, mcp_read="1/min")
        raw_a = _mint_personal(owner)
        raw_b = _mint_personal(owner)
        # Token A exhausts its own 1/min bucket.
        assert _bearer(raw_a).get(_ME_URL).status_code == 200
        assert _bearer(raw_a).get(_ME_URL).status_code == 429
        # Token B (same owner, different token) is on a fresh bucket.
        assert _bearer(raw_b).get(_ME_URL).status_code == 200
    finally:
        cache.clear()


# ---------------------------------------------------------------------------
# Integration: compute-heavy views stack the tighter mcp_read_compute throttle
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_compute_heavy_view_stacks_tighter_bucket(
    owner: Any, project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A compute-heavy MCP read (monte-carlo/latest) trips ``mcp_read_compute`` first.

    ``mcp_read`` is left at its generous default so only the tighter compute bucket
    can be the limiter here. No Monte Carlo actually runs — with no cached/persisted
    result the view returns 404, but the throttle is checked *before* the handler,
    so the second call is 429.
    """
    cache.clear()
    try:
        _set_rates(monkeypatch, mcp_read_compute="1/min")
        raw = _mint_personal(owner)
        client = _bearer(raw)
        url = f"/api/v1/projects/{project.pk}/monte-carlo/latest/"
        first = client.get(url).status_code
        second = client.get(url).status_code
        assert first == 404, first  # no run yet — but the bucket was consumed
        assert second == 429, second
    finally:
        cache.clear()


@pytest.mark.django_db
def test_human_session_not_compute_throttled(
    owner: Any, project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A session user is never bounded by the compute throttle, however tight."""
    cache.clear()
    try:
        _set_rates(monkeypatch, mcp_read_compute="1/min")
        client = APIClient()
        client.force_authenticate(user=owner)
        url = f"/api/v1/projects/{project.pk}/monte-carlo/latest/"
        statuses = [client.get(url).status_code for _ in range(3)]
        # All 404 (no run) — crucially none is 429.
        assert statuses == [404] * 3, statuses
    finally:
        cache.clear()
