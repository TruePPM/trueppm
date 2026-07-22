"""Unit tests for the atomic INCR-with-TTL throttle primitives (#1757).

The counter throttles historically did ``INCR`` then a separate ``EXPIRE`` — a
crash between the two left the key without a TTL, wedging the principal at 429
for that bucket forever. ``incr_with_ttl`` / ``incrby_with_ttl`` collapse both
into one Lua ``EVAL`` so the counter can never outlive its window. These tests
pin the two guarantees the helpers must provide against a Redis stand-in that
faithfully emulates the scripts: the returned count, and the TTL semantics
(first-hit-only for ``incr_with_ttl``; every-call for ``incrby_with_ttl``).
"""

from __future__ import annotations

import redis

from trueppm_api.core.redis_throttle import incr_with_ttl, incrby_with_ttl


class _ScriptRedis:
    """Emulates the two throttle Lua scripts by parsing the script text.

    Mirrors what a real Redis does for the exact scripts the helpers ship: INCR
    (or INCRBY) the key, then EXPIRE it — unconditionally for the INCRBY script,
    only on the transition to 1 for the INCR script. Records each EXPIRE so the
    tests can assert the first-hit-only vs every-call TTL contract.
    """

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.expire_calls: list[tuple[str, int]] = []

    def eval(self, script: str, numkeys: int, *args: object) -> int:
        assert numkeys == 1
        key = str(args[0])
        if "INCRBY" in script:
            amount = int(args[1])  # type: ignore[arg-type]
            ttl = int(args[2])  # type: ignore[arg-type]
            self.counts[key] = self.counts.get(key, 0) + amount
            self.expire_calls.append((key, ttl))  # unconditional
        else:
            ttl = int(args[1])  # type: ignore[arg-type]
            self.counts[key] = self.counts.get(key, 0) + 1
            if self.counts[key] == 1:
                self.expire_calls.append((key, ttl))  # first hit only
        return self.counts[key]


class _BoomRedis:
    def eval(self, *_args: object, **_kwargs: object) -> int:
        raise redis.RedisError("down")


# --- incr_with_ttl ---------------------------------------------------------


def test_incr_returns_incrementing_count() -> None:
    """Successive calls return 1, 2, 3 … for the same key."""
    fake = _ScriptRedis()
    assert incr_with_ttl(fake, "k", 60) == 1
    assert incr_with_ttl(fake, "k", 60) == 2
    assert incr_with_ttl(fake, "k", 60) == 3


def test_incr_sets_ttl_only_on_first_hit() -> None:
    """The TTL is stamped once (on the 1st increment), not on every call.

    This is the whole point: the window is fixed from the first request, and a
    later increment inside the window does not extend it.
    """
    fake = _ScriptRedis()
    incr_with_ttl(fake, "k", 60)
    incr_with_ttl(fake, "k", 60)
    incr_with_ttl(fake, "k", 60)
    assert fake.expire_calls == [("k", 60)]


def test_incr_keys_are_independent() -> None:
    """Each key gets its own counter and its own first-hit TTL."""
    fake = _ScriptRedis()
    assert incr_with_ttl(fake, "a", 60) == 1
    assert incr_with_ttl(fake, "b", 30) == 1
    assert fake.expire_calls == [("a", 60), ("b", 30)]


def test_incr_propagates_redis_error() -> None:
    """A broker failure surfaces so the caller can apply its fail policy."""
    try:
        incr_with_ttl(_BoomRedis(), "k", 60)
    except redis.RedisError:
        return
    raise AssertionError("expected RedisError to propagate")


# --- incrby_with_ttl -------------------------------------------------------


def test_incrby_adds_amount_and_refreshes_ttl_every_call() -> None:
    """INCRBY advances by ``amount`` and re-stamps the (sliding) TTL each call."""
    fake = _ScriptRedis()
    assert incrby_with_ttl(fake, "k", 3, 3600) == 3
    assert incrby_with_ttl(fake, "k", 2, 3600) == 5
    # Unlike incr_with_ttl, the TTL is refreshed on EVERY call.
    assert fake.expire_calls == [("k", 3600), ("k", 3600)]


def test_incrby_propagates_redis_error() -> None:
    try:
        incrby_with_ttl(_BoomRedis(), "k", 1, 60)
    except redis.RedisError:
        return
    raise AssertionError("expected RedisError to propagate")
