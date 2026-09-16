"""Unit tests for the capacity harness's token-refresh and reporting logic (#3828).

`packages/api/perf/capacity/run_capacity.py` produced a fabricated "16,000-task
ceiling": the harness cached its JWT for the life of the process with no refresh,
`ACCESS_TOKEN_LIFETIME` is 15 minutes, and the `tasks` sweep ran 17m51s — so its
final step measured a wall of 401s at auth-rejection speed (~4.8 ms), not database
latency. The host-noise control of the time (`/api/v1/health/`) is unauthenticated
and could not see the 401s either.

This module has no live stack: it is not a fixture module for the harness, it is
the harness *script* itself, imported by file path (it lives under `perf/`, not
`src/`, so it is not an installed part of `trueppm_api` — same idiom as
`tests/apps/observability/test_helm_metric_name_sync.py`). The three things tested
here are pure and do not touch the network or a database:

* the time-aware token cache refreshes after `TOKEN_REFRESH_AFTER` and not before;
* a step's `status_histogram` is built correctly from its samples, so a wall of
  401s is now distinguishable from a wall of 500s or timeouts;
* the host-noise control now samples an authenticated, constant-cost endpoint
  (`CONTROL_PATH`) instead of the unauthenticated `/api/v1/health/`.

Deliberately does NOT bring up `docker-compose.capacity.yml` or perform a real
HTTP call — `requests.post` is monkeypatched in every test that exercises
`Client`/`_login`.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
MODULE_PATH = REPO_ROOT / "packages" / "api" / "perf" / "capacity" / "run_capacity.py"


def _load_module() -> ModuleType:
    """Import the harness script by path — it is a script, not an installed module."""
    spec = importlib.util.spec_from_file_location("run_capacity", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def capacity() -> ModuleType:
    if not MODULE_PATH.is_file():
        pytest.fail(f"{MODULE_PATH} is missing — the #3828 harness tests have no target")
    return _load_module()


@pytest.fixture(autouse=True)
def _clear_token_cache(capacity: ModuleType) -> None:
    """The module-level `_TOKEN_CACHE` persists across tests in this session; reset it."""
    capacity._TOKEN_CACHE.clear()


class _FakeResponse:
    """Stand-in for `requests.Response` — no network, no `pytest-socket` trip."""

    def __init__(self, status_code: int, payload: dict[str, Any] | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict[str, Any]:
        return self._payload

    def raise_for_status(self) -> None:
        raise RuntimeError(f"HTTP {self.status_code}")


# ──────────────────────────────────────────────────────────────────────────
# Token refresh
# ──────────────────────────────────────────────────────────────────────────


def test_token_is_fresh_within_margin(capacity: ModuleType) -> None:
    cached = capacity._CachedToken(token="tok", minted_at=0.0)
    margin = capacity.TOKEN_REFRESH_AFTER.total_seconds()
    assert capacity._token_is_fresh(cached, now=margin - 1) is True


def test_token_is_stale_past_margin(capacity: ModuleType) -> None:
    cached = capacity._CachedToken(token="tok", minted_at=0.0)
    margin = capacity.TOKEN_REFRESH_AFTER.total_seconds()
    assert capacity._token_is_fresh(cached, now=margin + 1) is False


def test_login_reuses_cached_token_within_margin(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A second `_login()` inside the refresh margin must not re-authenticate.

    This is the throttle-safety property the original (pre-#3828) code had —
    the fix must not regress it back into re-authenticating per request.
    """
    monkeypatch.setattr(capacity, "owner_password", lambda: "throwaway")
    clock = {"t": 0.0}
    monkeypatch.setattr(capacity.time, "monotonic", lambda: clock["t"])

    calls = 0

    def fake_post(url: str, json: dict[str, Any], timeout: int) -> _FakeResponse:
        nonlocal calls
        calls += 1
        return _FakeResponse(200, {"access": f"token-{calls}"})

    monkeypatch.setattr(capacity.requests, "post", fake_post)

    client = capacity.Client()
    assert client.token == "token-1"
    assert calls == 1

    # Still inside the refresh margin.
    clock["t"] = capacity.TOKEN_REFRESH_AFTER.total_seconds() - 1
    client.ensure_fresh_token()
    assert client.token == "token-1"
    assert calls == 1


def test_ensure_fresh_token_remints_past_margin(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """This is the #3828 fix itself: a token older than the margin gets replaced.

    Simulates a sweep step that starts after the cached token has aged past
    `TOKEN_REFRESH_AFTER` (e.g. a long-running earlier step) — exactly the
    condition the 16,000-task step hit at minute 17 against a 15-minute
    lifetime with no refresh at all.
    """
    monkeypatch.setattr(capacity, "owner_password", lambda: "throwaway")
    clock = {"t": 0.0}
    monkeypatch.setattr(capacity.time, "monotonic", lambda: clock["t"])

    calls = 0

    def fake_post(url: str, json: dict[str, Any], timeout: int) -> _FakeResponse:
        nonlocal calls
        calls += 1
        return _FakeResponse(200, {"access": f"token-{calls}"})

    monkeypatch.setattr(capacity.requests, "post", fake_post)

    client = capacity.Client()
    assert client.token == "token-1"

    clock["t"] = capacity.TOKEN_REFRESH_AFTER.total_seconds() + 1
    client.ensure_fresh_token()
    assert client.token == "token-2"
    assert calls == 2


def test_login_backs_off_through_throttle_then_succeeds(
    capacity: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pre-existing 429 backoff must survive the refresh-margin change."""
    monkeypatch.setattr(capacity, "owner_password", lambda: "throwaway")
    monkeypatch.setattr(capacity.time, "monotonic", lambda: 0.0)
    monkeypatch.setattr(capacity.time, "sleep", lambda _seconds: None)

    responses = [_FakeResponse(429), _FakeResponse(200, {"access": "token-after-throttle"})]

    def fake_post(url: str, json: dict[str, Any], timeout: int) -> _FakeResponse:
        return responses.pop(0)

    monkeypatch.setattr(capacity.requests, "post", fake_post)

    client = capacity.Client()
    assert client.token == "token-after-throttle"


def test_password_never_lands_in_cached_token_or_results(capacity: ModuleType) -> None:
    """The token cache stores the bearer token only — never the password."""
    cached = capacity._CachedToken(token="tok", minted_at=0.0)
    assert "throwaway" not in vars(cached).values()
    assert set(vars(cached)) == {"token", "minted_at"}


# ──────────────────────────────────────────────────────────────────────────
# Status-code histogram
# ──────────────────────────────────────────────────────────────────────────


def test_status_histogram_distinguishes_error_classes(capacity: ModuleType) -> None:
    """A wall of 401s must be distinguishable from a wall of 500s in the results.

    This is the exact blind spot #3828 exploited: `error_rate=0.9667` alone was
    consistent with a database problem, a 500-storm, or (the actual cause) an
    expired token — the histogram is what makes the distinction visible in the
    committed JSON without re-running anything.
    """
    Sample = capacity.Sample
    samples = [Sample(ms=4.8, status=401, ok=False) for _ in range(29)] + [
        Sample(ms=5.1, status=200, ok=True)
    ]
    result = capacity.summarize(16000, "16000 tasks — first page", samples)
    assert result.status_histogram == {"401": 29, "200": 1}
    # error_rate is rounded to 4 places by summarize(), same as production.
    assert result.error_rate == round(29 / 30, 4)


def test_status_histogram_all_success(capacity: ModuleType) -> None:
    Sample = capacity.Sample
    samples = [Sample(ms=10.0, status=200, ok=True) for _ in range(5)]
    result = capacity.summarize(500, "500 tasks", samples)
    assert result.status_histogram == {"200": 5}


def test_status_histogram_empty_samples(capacity: ModuleType) -> None:
    result = capacity.summarize(500, "500 tasks", [])
    assert result.status_histogram == {}


# ──────────────────────────────────────────────────────────────────────────
# Authenticated control probe
# ──────────────────────────────────────────────────────────────────────────


def test_control_sample_uses_authenticated_constant_cost_endpoint(
    capacity: ModuleType,
) -> None:
    """The control must hit `CONTROL_PATH`, not the unauthenticated health probe.

    `/api/v1/health/` cannot see a 401 — it needs no token — which is why the
    #3828 sweep's control sample stayed green (6.7 ms) throughout a step that
    was 96.67% auth failures. The control must now be able to see that class of
    failure.
    """
    calls: list[str] = []

    class _FakeClient:
        def timed(self, path: str) -> capacity.Sample:  # type: ignore[name-defined]
            calls.append(path)
            return capacity.Sample(ms=1.0, status=200, ok=True)

    capacity.control_sample(_FakeClient(), n=3)

    assert calls == [capacity.CONTROL_PATH] * 3
    assert capacity.CONTROL_PATH != "/api/v1/health/"
    assert "auth" in capacity.CONTROL_PATH
