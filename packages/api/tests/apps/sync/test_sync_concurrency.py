"""Unit tests for the per-user sync-batch concurrency semaphore (#1756).

``SyncUploadThrottle`` bounds requests/minute, but each accepted batch is a heavy
``transaction.atomic()`` (up to ``TRUEPPM_SYNC_BATCH_MAX_ROWS`` row locks + a CPM
recalc enqueue). ``sync_batch_concurrency_slot`` is the defense-in-depth guard
around the apply: a per-user Redis slot count, INCR on entry / DECR on exit, that
rejects with 429 (``Throttled``) once ``TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES`` are
already in flight. These exercise the context manager directly against a fake
Redis: it admits up to the cap, releases the slot on both normal and error exit,
rejects (and refunds its own increment) over the cap, is TTL-guarded against a
crashed-worker slot leak, and fails OPEN on a Redis outage so the rate cap — not
this layer — remains the hard bound.
"""

from __future__ import annotations

import pytest
import redis
from django.test import override_settings
from rest_framework.exceptions import Throttled

from trueppm_api.apps.sync import throttles
from trueppm_api.apps.sync.throttles import sync_batch_concurrency_slot


class _FakeRedis:
    """In-memory slot counter emulating the incrby_with_ttl EVAL + decr the guard uses."""

    def __init__(self, raise_on_eval: bool = False, raise_on_decr: bool = False) -> None:
        self.counts: dict[str, int] = {}
        self.expire_calls: list[tuple[str, int]] = []
        self._raise_on_eval = raise_on_eval
        self._raise_on_decr = raise_on_decr

    def eval(self, script: str, numkeys: int, *args: object) -> int:
        if self._raise_on_eval:
            raise redis.RedisError("down")
        key = str(args[0])
        amount = int(args[1])  # type: ignore[arg-type]
        ttl = int(args[2])  # type: ignore[arg-type]
        self.counts[key] = self.counts.get(key, 0) + amount
        self.expire_calls.append((key, ttl))
        return self.counts[key]

    def decr(self, key: str) -> int:
        if self._raise_on_decr:
            raise redis.RedisError("down")
        self.counts[key] = self.counts.get(key, 0) - 1
        return self.counts[key]


_KEY = "inflight:sync_upload:user:u1"


def test_admits_under_cap_and_releases_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    """A batch under the cap runs, and the slot is released on normal exit."""
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    with (
        override_settings(TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=4),
        sync_batch_concurrency_slot("u1"),
    ):
        # Inside the block the slot is held.
        assert fake.counts[_KEY] == 1
    # Released on exit.
    assert fake.counts[_KEY] == 0


def test_ttl_is_refreshed_on_acquire(monkeypatch: pytest.MonkeyPatch) -> None:
    """The slot counter carries its leak-guard TTL, stamped on entry (#1756)."""
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    with (
        override_settings(TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS=120),
        sync_batch_concurrency_slot("u1"),
    ):
        pass
    assert fake.expire_calls == [(_KEY, 120)]


def test_releases_slot_when_body_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """An exception inside the guarded block still releases the slot (finally)."""
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    with (
        override_settings(TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=4),
        pytest.raises(ValueError),
        sync_batch_concurrency_slot("u1"),
    ):
        raise ValueError("boom")
    assert fake.counts[_KEY] == 0


def test_rejects_over_cap_with_throttled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Entering with the cap already in flight raises Throttled (→ 429)."""
    # Pre-load the counter at the cap so the next acquire crosses it.
    fake = _FakeRedis()
    fake.counts[_KEY] = 4
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    with (
        override_settings(TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=4),
        pytest.raises(Throttled),
        sync_batch_concurrency_slot("u1"),
    ):
        raise AssertionError("body must not run when over cap")

    # The rejected request refunds its own increment: it incremented to 5, then
    # decremented back to 4 — it must not leave a phantom slot held.
    assert fake.counts[_KEY] == 4


def test_concurrent_slots_stack_then_drain(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nested (concurrent) holders count up to the cap and drain back down."""
    fake = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    # Genuinely nested: each level must observe the count between acquire/release,
    # so these withs cannot be flattened into one statement.
    with override_settings(TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=2):  # noqa: SIM117
        with sync_batch_concurrency_slot("u1"):
            assert fake.counts[_KEY] == 1
            with sync_batch_concurrency_slot("u1"):
                assert fake.counts[_KEY] == 2
                # A third concurrent holder would exceed the cap of 2.
                with pytest.raises(Throttled), sync_batch_concurrency_slot("u1"):
                    pass
            assert fake.counts[_KEY] == 1
    assert fake.counts[_KEY] == 0


def test_fails_open_on_redis_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Redis outage degrades to running WITHOUT the guard, never blocking (#1756).

    Unlike the rate throttle (which fails closed because it is the only global DoS
    bound), this defense-in-depth layer fails open — the per-minute rate cap still
    applies, so nothing removes the hard bound.
    """
    fake = _FakeRedis(raise_on_eval=True)
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    ran = False
    with sync_batch_concurrency_slot("u1"):
        ran = True
    assert ran is True


def test_release_error_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Redis error on release does not propagate — the TTL reclaims the slot."""
    fake = _FakeRedis(raise_on_decr=True)
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    # Must not raise even though decr() blows up on exit.
    with sync_batch_concurrency_slot("u1"):
        pass
