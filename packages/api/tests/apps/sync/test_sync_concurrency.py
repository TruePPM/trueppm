"""Unit tests for the per-user sync-batch concurrency semaphore (#1756, #2287).

``SyncUploadThrottle`` bounds requests/minute, but each accepted batch is a heavy
``transaction.atomic()`` (up to ``TRUEPPM_SYNC_BATCH_MAX_ROWS`` row locks + a CPM
recalc enqueue). ``sync_batch_concurrency_slot`` is the defense-in-depth guard
around the apply: a per-user set of holder leases that rejects with 429
(``Throttled``) once ``TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES`` are in flight.

These exercise the context manager against a fake Redis that emulates the acquire
script's semantics (reap expired leases, count, admit) and ``ZREM`` with a
controllable clock. The #2287 tests pin the two drift directions the old shared
INCR/DECR counter had: a release after the lease expired must not undercount,
and a crash-leaked slot must free itself while uploads keep arriving.
"""

from __future__ import annotations

import os
import time
import uuid

import pytest
import redis
from django.test import override_settings
from rest_framework.exceptions import Throttled

from trueppm_api.apps.sync import throttles
from trueppm_api.apps.sync.throttles import sync_batch_concurrency_slot


class _FakeRedis:
    """In-memory emulation of the lease script + ``zrem`` the guard uses."""

    def __init__(self, raise_on_eval: bool = False, raise_on_release: bool = False) -> None:
        self.now = 1_000
        self.leases: dict[str, dict[str, int]] = {}
        self.lease_args: list[int] = []
        self._raise_on_eval = raise_on_eval
        self._raise_on_release = raise_on_release

    def eval(self, script: str, numkeys: int, *args: object) -> int:
        if self._raise_on_eval:
            raise redis.RedisError("down")
        assert script == throttles._ACQUIRE_SLOT_LUA
        key, lease, cap, holder = str(args[0]), int(args[1]), int(args[2]), str(args[3])  # type: ignore[arg-type]
        self.lease_args.append(lease)
        live = {h: exp for h, exp in self.leases.get(key, {}).items() if exp > self.now}
        self.leases[key] = live
        if len(live) >= cap:
            return 0
        live[holder] = self.now + lease
        return 1

    def zrem(self, key: str, holder: str) -> int:
        if self._raise_on_release:
            raise redis.RedisError("down")
        return 1 if self.leases.get(key, {}).pop(holder, None) is not None else 0

    def held(self) -> int:
        return sum(1 for exp in self.leases.get(_KEY, {}).values() if exp > self.now)


_KEY = "inflight:sync_upload:holders:user:u1"


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> _FakeRedis:
    f = _FakeRedis()
    monkeypatch.setattr(throttles, "_client", lambda: f)
    return f


def test_admits_under_cap_and_releases_slot(fake: _FakeRedis) -> None:
    """A batch under the cap runs, and its lease is released on normal exit."""
    with (
        override_settings(TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=4),
        sync_batch_concurrency_slot("u1"),
    ):
        assert fake.held() == 1
    assert fake.held() == 0


def test_lease_length_is_the_inflight_ttl(fake: _FakeRedis) -> None:
    """Each lease runs ``TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS`` (#1756)."""
    with (
        override_settings(TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS=120),
        sync_batch_concurrency_slot("u1"),
    ):
        pass
    assert fake.lease_args == [120]


def test_releases_slot_when_body_raises(fake: _FakeRedis) -> None:
    """An exception inside the guarded block still releases the lease (finally)."""
    with (
        override_settings(TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=4),
        pytest.raises(ValueError),
        sync_batch_concurrency_slot("u1"),
    ):
        raise ValueError("boom")
    assert fake.held() == 0


def test_rejects_over_cap_without_taking_a_lease(fake: _FakeRedis) -> None:
    """At the cap, the next acquire raises Throttled (→ 429) and holds nothing."""
    fake.leases[_KEY] = {f"h{i}": fake.now + 120 for i in range(4)}

    with (
        override_settings(TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=4),
        pytest.raises(Throttled),
        sync_batch_concurrency_slot("u1"),
    ):
        raise AssertionError("body must not run when over cap")
    assert fake.held() == 4


def test_concurrent_slots_stack_then_drain(fake: _FakeRedis) -> None:
    """Nested (concurrent) holders count up to the cap and drain back down."""
    # Genuinely nested: each level must observe the count between acquire/release,
    # so these withs cannot be flattened into one statement.
    with override_settings(TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=2):  # noqa: SIM117
        with sync_batch_concurrency_slot("u1"):
            assert fake.held() == 1
            with sync_batch_concurrency_slot("u1"):
                assert fake.held() == 2
                with pytest.raises(Throttled), sync_batch_concurrency_slot("u1"):
                    pass
            assert fake.held() == 1
    assert fake.held() == 0


def test_release_after_lease_expiry_cannot_widen_the_cap(fake: _FakeRedis) -> None:
    """#2287 negative drift: a holder outliving its lease must not undercount.

    Under the shared counter the key expired mid-apply, a later acquire re-created
    it from 0, and the original holder's DECR drove it to -1 — admitting cap + 1
    from then on. A lease release removes only its own id, so the cap holds.
    """
    with (
        override_settings(
            TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=2, TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS=120
        ),
        sync_batch_concurrency_slot("u1"),
    ):
        fake.now += 121  # the long apply outlives its lease
        with sync_batch_concurrency_slot("u1"):
            pass
    # Two fresh holders fill the cap of 2 exactly; a third is refused.
    with override_settings(TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=2):  # noqa: SIM117
        with sync_batch_concurrency_slot("u1"), sync_batch_concurrency_slot("u1"):
            with pytest.raises(Throttled), sync_batch_concurrency_slot("u1"):
                pass


def test_crash_leaked_slot_frees_itself_under_continuous_uploads(fake: _FakeRedis) -> None:
    """#2287 leaked-slot accumulation: a dead holder's lease ends on its own clock.

    The shared counter refreshed one TTL on every entry, so a leaked +1 survived
    for as long as the user kept uploading. Here a leaked lease is reaped once it
    expires even though acquires keep arriving inside every window.
    """
    fake.leases[_KEY] = {"crashed": fake.now + 120}
    with override_settings(TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=1):
        for _ in range(4):  # continuous traffic, each well inside the window
            with pytest.raises(Throttled), sync_batch_concurrency_slot("u1"):
                pass
            fake.now += 20
        fake.now += 41  # past the leaked lease's own expiry
        with sync_batch_concurrency_slot("u1"):
            assert fake.held() == 1


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
    """A Redis error on release does not propagate — the lease expires on its own."""
    fake = _FakeRedis(raise_on_release=True)
    monkeypatch.setattr(throttles, "_client", lambda: fake)

    with sync_batch_concurrency_slot("u1"):
        pass


# ---------------------------------------------------------------------------
# The real Lua script against a real Valkey (#2287)
# ---------------------------------------------------------------------------
#
# ``_FakeRedis.eval`` above re-implements ``_ACQUIRE_SLOT_LUA`` in Python, so the
# tests above prove the context manager's wiring, not the script. This one runs
# the script itself. It needs a Valkey/Redis the test may write to and is skipped
# unless ``TRUEPPM_TEST_REAL_VALKEY_URL`` points at one — deliberately NOT the
# app's ``REDIS_URL``, which on a shared dev host can belong to another stack. It
# writes one random key and deletes it.

_REAL_VALKEY_URL = os.environ.get("TRUEPPM_TEST_REAL_VALKEY_URL", "")


@pytest.mark.skipif(
    not _REAL_VALKEY_URL,
    reason="set TRUEPPM_TEST_REAL_VALKEY_URL to a disposable Valkey to run the real Lua script",
)
def test_acquire_slot_lua_against_real_valkey(monkeypatch: pytest.MonkeyPatch) -> None:
    """Admit up to the cap, refuse over it, free on ZREM, free on lease expiry."""
    client = redis.Redis.from_url(_REAL_VALKEY_URL)
    monkeypatch.setattr(throttles, "_client", lambda: client)
    user_pk = f"lua-test-{uuid.uuid4().hex}"
    key = f"inflight:sync_upload:holders:user:{user_pk}"
    try:
        with override_settings(
            TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES=2, TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS=60
        ):
            with sync_batch_concurrency_slot(user_pk), sync_batch_concurrency_slot(user_pk):
                assert client.zcard(key) == 2
                with pytest.raises(Throttled), sync_batch_concurrency_slot(user_pk):
                    pass
                assert client.zcard(key) == 2, "a refused acquire must take no lease"
            assert client.zcard(key) == 0, "release (ZREM) must free both leases"

        # Lease expiry: a holder that never releases stops counting once its own
        # lease ends — the next acquire reaps it inside the script.
        assert client.eval(throttles._ACQUIRE_SLOT_LUA, 1, key, 1, 1, "leaked") == 1
        assert client.eval(throttles._ACQUIRE_SLOT_LUA, 1, key, 1, 1, "blocked") == 0
        time.sleep(2.1)
        assert client.eval(throttles._ACQUIRE_SLOT_LUA, 1, key, 1, 1, "after") == 1
        assert client.zrange(key, 0, -1) == [b"after"]
    finally:
        client.delete(key)
