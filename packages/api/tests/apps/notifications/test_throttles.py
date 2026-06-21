"""Unit tests for MentionRateThrottle and record_mention_usage (#784).

The mention rate limiter (ADR-0075 #8/#9) is the abuse-prevention gate on the
comment-create fan-out, but it had zero behavior coverage — every other test
*patches it away* (``test_task_collaboration.py`` bypasses ``allow_request`` and
``record_mention_usage`` so the create path never hits Redis). These exercise
the limiter directly with a fake Redis client: both burst windows block, the
counters increment with the right TTLs, and a Redis outage fails *open* so a
counter glitch can never wedge legitimate commenting.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
import redis

from trueppm_api.apps.notifications import throttles
from trueppm_api.apps.notifications.services import (
    MENTION_DAILY_LIMIT,
    MENTION_HOURLY_BURST,
)
from trueppm_api.apps.notifications.throttles import (
    MentionRateThrottle,
    record_mention_usage,
)


class _FakePipeline:
    """Records the incrby/expire ops issued before execute()."""

    def __init__(self, raise_on_execute: bool = False) -> None:
        self.ops: list[tuple[str, str, int]] = []
        self.executed = False
        self._raise_on_execute = raise_on_execute

    def incrby(self, key: str, amount: int) -> _FakePipeline:
        self.ops.append(("incrby", key, amount))
        return self

    def expire(self, key: str, ttl: int) -> _FakePipeline:
        self.ops.append(("expire", key, ttl))
        return self

    def execute(self) -> list[None]:
        if self._raise_on_execute:
            raise redis.RedisError("down")
        self.executed = True
        return [None] * len(self.ops)


class _FakeRedis:
    """Minimal stand-in returning canned counter values."""

    def __init__(
        self,
        values: dict[str, int] | None = None,
        raise_on_execute: bool = False,
    ) -> None:
        self._values = values or {}
        self._raise_on_execute = raise_on_execute
        self.pipelines: list[_FakePipeline] = []

    def get(self, key: str) -> int | None:
        return self._values.get(key)

    def pipeline(self) -> _FakePipeline:
        pipe = _FakePipeline(raise_on_execute=self._raise_on_execute)
        self.pipelines.append(pipe)
        return pipe


def _request(user: object) -> SimpleNamespace:
    return SimpleNamespace(user=user)


def _auth_user(pk: str = "u1") -> SimpleNamespace:
    return SimpleNamespace(pk=pk, is_authenticated=True)


# --- allow_request ---------------------------------------------------------


def test_anonymous_request_is_allowed() -> None:
    """An unauthenticated request is not rate limited (no per-user bucket)."""
    throttle = MentionRateThrottle()
    assert throttle.allow_request(_request(None), view=None) is True
    anon = SimpleNamespace(is_authenticated=False)
    assert throttle.allow_request(_request(anon), view=None) is True


def test_allowed_under_both_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Below both windows the request passes and no wait is set."""
    monkeypatch.setattr(throttles, "_client", lambda: _FakeRedis({}))
    throttle = MentionRateThrottle()

    assert throttle.allow_request(_request(_auth_user()), view=None) is True
    assert throttle.wait() is None


def test_hourly_burst_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    """At the hourly burst ceiling the request is denied with a 1-hour wait."""
    monkeypatch.setattr(
        throttles,
        "_client",
        lambda: _FakeRedis({"mention:hour:u1": MENTION_HOURLY_BURST, "mention:day:u1": 0}),
    )
    throttle = MentionRateThrottle()

    assert throttle.allow_request(_request(_auth_user()), view=None) is False
    assert throttle.wait() == 3600.0


def test_daily_limit_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Under the hourly burst but at the daily cap → denied with a 1-day wait."""
    monkeypatch.setattr(
        throttles,
        "_client",
        lambda: _FakeRedis({"mention:hour:u1": 0, "mention:day:u1": MENTION_DAILY_LIMIT}),
    )
    throttle = MentionRateThrottle()

    assert throttle.allow_request(_request(_auth_user()), view=None) is False
    assert throttle.wait() == 86400.0


def test_allow_request_fails_open_on_redis_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Redis outage must never wedge commenting — fail open (allow)."""

    def _boom() -> object:
        raise redis.RedisError("down")

    monkeypatch.setattr(throttles, "_client", _boom)
    throttle = MentionRateThrottle()

    assert throttle.allow_request(_request(_auth_user()), view=None) is True


# --- record_mention_usage --------------------------------------------------


def test_record_increments_both_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    """A positive count bumps the hour and day counters and (re)sets their TTLs."""
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    record_mention_usage("u1", 3)

    pipe = fake.pipelines[0]
    assert pipe.ops == [
        ("incrby", "mention:hour:u1", 3),
        ("expire", "mention:hour:u1", 3600),
        ("incrby", "mention:day:u1", 3),
        ("expire", "mention:day:u1", 86400),
    ]
    assert pipe.executed is True


@pytest.mark.parametrize("count", [0, -5])
def test_record_is_noop_for_nonpositive_count(count: int, monkeypatch: pytest.MonkeyPatch) -> None:
    """Zero/negative counts short-circuit before touching Redis."""

    def _should_not_be_called() -> object:
        raise AssertionError("Redis client must not be created for a non-positive count")

    monkeypatch.setattr(throttles, "_client", _should_not_be_called)

    record_mention_usage("u1", count)  # must not raise


def test_record_fails_open_on_redis_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """If the pipeline execute fails, the caller is not blown up — fail open."""
    monkeypatch.setattr(throttles, "_client", lambda: _FakeRedis(raise_on_execute=True))

    record_mention_usage("u1", 2)  # must not raise
