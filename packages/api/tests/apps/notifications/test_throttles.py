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


class _FakeRedis:
    """Minimal stand-in: ``get`` for the read throttle, ``eval`` for the atomic
    INCRBY+EXPIRE helper (#1757) ``record_mention_usage`` now issues."""

    def __init__(
        self,
        values: dict[str, int] | None = None,
        raise_on_eval: bool = False,
    ) -> None:
        self._values = values or {}
        self._raise_on_eval = raise_on_eval
        # Recorded (key, amount, ttl) for each incrby_with_ttl EVAL, in call order.
        self.eval_calls: list[tuple[str, int, int]] = []

    def get(self, key: str) -> int | None:
        return self._values.get(key)

    def eval(self, script: str, numkeys: int, *args: object) -> int:
        """Emulate the incrby_with_ttl Lua: INCRBY the key by args[1], stamp TTL."""
        if self._raise_on_eval:
            raise redis.RedisError("down")
        key = str(args[0])
        amount = int(args[1])  # type: ignore[arg-type]
        ttl = int(args[2])  # type: ignore[arg-type]
        self._values[key] = int(self._values.get(key, 0)) + amount
        self.eval_calls.append((key, amount, ttl))
        return self._values[key]


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
    """A positive count atomically bumps the hour and day counters with their TTLs.

    Each counter is a single ``incrby_with_ttl`` EVAL (#1757) — the INCRBY and the
    EXPIRE are one atomic unit, so a crash can no longer strand a mention counter
    without a window (which would wedge the user at the mention cap indefinitely).
    """
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    record_mention_usage("u1", 3)

    assert fake.eval_calls == [
        ("mention:hour:u1", 3, 3600),
        ("mention:day:u1", 3, 86400),
    ]


@pytest.mark.parametrize("count", [0, -5])
def test_record_is_noop_for_nonpositive_count(count: int, monkeypatch: pytest.MonkeyPatch) -> None:
    """Zero/negative counts short-circuit before touching Redis."""

    def _should_not_be_called() -> object:
        raise AssertionError("Redis client must not be created for a non-positive count")

    monkeypatch.setattr(throttles, "_client", _should_not_be_called)

    record_mention_usage("u1", count)  # must not raise


def test_record_fails_open_on_redis_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """If the atomic EVAL fails, the caller is not blown up — fail open."""
    monkeypatch.setattr(throttles, "_client", lambda: _FakeRedis(raise_on_eval=True))

    record_mention_usage("u1", 2)  # must not raise
