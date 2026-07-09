"""Unit tests for SyncUploadThrottle — the sync-upload write rate limiter (#1719).

The upload throttle gates the heavyweight write path (a 500-row batch inside one
``transaction.atomic()`` with row locks + a CPM recalc enqueue). Two properties are
security-critical and had no coverage before #1719:

- it fails **closed** on a Redis error (the old code failed open, so a cache blip
  removed the only DoS bound globally), and
- it enforces a per-user GLOBAL bucket in addition to the per-project one, so a
  member of N projects cannot sustain ``UPLOAD_LIMIT × N`` batch writes/min by
  spreading them across projects.

These exercise ``allow_request`` directly against a fake Redis, mirroring the
``notifications.test_throttles`` pattern.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
import redis

from trueppm_api.apps.sync import throttles
from trueppm_api.apps.sync.throttles import (
    GLOBAL_UPLOAD_LIMIT,
    UPLOAD_LIMIT,
    SyncUploadThrottle,
)


class _FakePipeline:
    """Applies queued incr/expire ops against the parent fake's counter dict."""

    def __init__(self, parent: _FakeRedis, raise_on_execute: bool = False) -> None:
        self._parent = parent
        self._ops: list[tuple[str, str]] = []
        self._raise = raise_on_execute

    def incr(self, key: str) -> _FakePipeline:
        self._ops.append(("incr", key))
        return self

    def expire(self, key: str, ttl: int) -> _FakePipeline:
        # ttl is unused by the fake — the real throttle sets a 60s window.
        self._ops.append(("expire", key))
        return self

    def execute(self) -> list[int]:
        if self._raise:
            raise redis.RedisError("down")
        results: list[int] = []
        for kind, key in self._ops:
            if kind == "incr":
                self._parent.counts[key] = self._parent.counts.get(key, 0) + 1
                results.append(self._parent.counts[key])
            else:  # expire
                results.append(1)
        return results


class _FakeRedis:
    """In-memory INCR counters, optionally raising on pipeline execute()."""

    def __init__(
        self, counts: dict[str, int] | None = None, raise_on_execute: bool = False
    ) -> None:
        self.counts = dict(counts or {})
        self._raise = raise_on_execute

    def pipeline(self) -> _FakePipeline:
        return _FakePipeline(self, self._raise)


def _request(user: object) -> SimpleNamespace:
    return SimpleNamespace(user=user)


def _view(pk: str) -> SimpleNamespace:
    return SimpleNamespace(kwargs={"pk": pk})


def _auth_user(pk: str = "u1") -> SimpleNamespace:
    return SimpleNamespace(pk=pk, is_authenticated=True)


# --- anonymous -------------------------------------------------------------


def test_anonymous_request_is_allowed() -> None:
    """Unauthenticated requests are not bucketed — the auth layer rejects them first."""
    throttle = SyncUploadThrottle()
    assert throttle.allow_request(_request(None), _view("p1")) is True
    anon = SimpleNamespace(is_authenticated=False)
    assert throttle.allow_request(_request(anon), _view("p1")) is True


# --- happy path ------------------------------------------------------------


def test_allowed_under_both_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    """A first upload is under both windows → allowed, no wait set."""
    monkeypatch.setattr(throttles, "_client", lambda: _FakeRedis())
    throttle = SyncUploadThrottle()
    assert throttle.allow_request(_request(_auth_user()), _view("p1")) is True
    assert throttle.wait() is None


def test_per_project_limit_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    """At the per-(project, user) ceiling the request is denied with a 60s wait."""
    counts = {"rate:sync_upload:p1:u1": UPLOAD_LIMIT, "rate:sync_upload:user:u1": 0}
    monkeypatch.setattr(throttles, "_client", lambda: _FakeRedis(counts))
    throttle = SyncUploadThrottle()
    assert throttle.allow_request(_request(_auth_user()), _view("p1")) is False
    assert throttle.wait() == 60


# --- #1719: per-user global bucket -----------------------------------------


def test_global_user_bucket_spans_projects(monkeypatch: pytest.MonkeyPatch) -> None:
    """The per-user bucket caps total writes across DIFFERENT projects (#1719).

    With a generous per-project ceiling but a global ceiling of 2, a third upload to
    a *third* project — whose own per-project bucket is still at 1 — is denied because
    the shared per-user bucket has crossed its limit.
    """
    monkeypatch.setattr(throttles, "UPLOAD_LIMIT", 100)
    monkeypatch.setattr(throttles, "GLOBAL_UPLOAD_LIMIT", 2)
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)
    user = _auth_user("u9")

    assert SyncUploadThrottle().allow_request(_request(user), _view("pA")) is True
    assert SyncUploadThrottle().allow_request(_request(user), _view("pB")) is True

    third = SyncUploadThrottle()
    assert third.allow_request(_request(user), _view("pC")) is False
    assert third.wait() == 60
    # Each per-project bucket is still well under its own ceiling — only the shared
    # per-user bucket tripped.
    assert fake.counts["rate:sync_upload:pC:u9"] == 1
    assert fake.counts["rate:sync_upload:user:u9"] == 3


def test_global_limit_uses_larger_ceiling_than_per_project() -> None:
    """Sanity: the global ceiling is >= the per-project one (legit multi-project replay)."""
    assert GLOBAL_UPLOAD_LIMIT >= UPLOAD_LIMIT


# --- #1719: fail closed ----------------------------------------------------


def test_fails_closed_on_redis_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Redis outage must DENY the write path (fail closed), not allow it (#1719).

    The pre-#1719 code returned True here, so a single cache blip removed the only
    DoS bound. The offline client retries with backoff, so a brief 429 is safe.
    """
    monkeypatch.setattr(throttles, "_client", lambda: _FakeRedis(raise_on_execute=True))
    throttle = SyncUploadThrottle()
    assert throttle.allow_request(_request(_auth_user()), _view("p1")) is False
    assert throttle.wait() == 60
