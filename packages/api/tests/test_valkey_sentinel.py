"""Tests for Valkey Sentinel support and the central client factory (ADR-0716, #2554).

Sentinel cannot be exercised end to end here — the bundled dev stack is a
single-node Valkey — so the factory tests assert on *what gets constructed*
(which topology, which database, which credentials) with a faked ``Sentinel``,
and the single-endpoint tests assert the pre-#2554 shape is preserved exactly.

The two tests that matter most for the long run are at the bottom:

* ``test_sentinel_cache_client_binds_to_real_django_base`` — ``valkey_cache``
  subclasses two private Django names, which a Django upgrade could move. This
  fails loudly rather than in production.
* ``test_no_new_raw_redis_url_clients`` — the whole point of the factory is that
  it is the *only* construction site. A new ``from_url(settings.REDIS_URL)``
  anywhere re-opens the silent-failover hole this issue closed.
"""

from __future__ import annotations

import pathlib
import re
from typing import TYPE_CHECKING, Any

import pytest
import redis
from django.core.cache.backends.redis import RedisCache, RedisCacheClient
from django.test import override_settings

from trueppm_api.core import valkey
from trueppm_api.core.valkey_cache import SentinelRedisCache, _SentinelCacheClient
from trueppm_api.core.valkey_checks import check_valkey_topology
from trueppm_api.core.valkey_config import parse_sentinels

if TYPE_CHECKING:
    from collections.abc import Iterator

SENTINELS = [("sentinel-0", 26379), ("sentinel-1", 26379)]


@pytest.fixture(autouse=True)
def _reset_managers() -> Iterator[None]:
    """Sentinel managers are process-global; clear them around every test."""
    valkey.reset_managers()
    yield
    valkey.reset_managers()


def sentinel_settings(**overrides: Any) -> dict[str, Any]:
    """Baseline Sentinel-mode settings, with per-test overrides."""
    return {
        "VALKEY_SENTINELS": SENTINELS,
        "VALKEY_SENTINELS_RAW": "sentinel-0:26379,sentinel-1:26379",
        "VALKEY_MASTER_NAME": "mymaster",
        "VALKEY_PASSWORD": "",
        "VALKEY_SENTINEL_PASSWORD": "",
        "VALKEY_USE_TLS": False,
        **overrides,
    }


# ---------------------------------------------------------------------------
# parse_sentinels
# ---------------------------------------------------------------------------


def test_parse_sentinels_empty_disables_sentinel_mode() -> None:
    assert parse_sentinels("") == []
    assert parse_sentinels("   ") == []


def test_parse_sentinels_reads_a_comma_separated_list() -> None:
    assert parse_sentinels("a:26379,b:26380") == [("a", 26379), ("b", 26380)]


def test_parse_sentinels_tolerates_whitespace_and_trailing_comma() -> None:
    assert parse_sentinels(" a:26379 , b:26380 , ") == [("a", 26379), ("b", 26380)]


def test_parse_sentinels_keeps_ipv6_literal_intact() -> None:
    """``rpartition`` must split only the final colon, not the address's own."""
    assert parse_sentinels("[::1]:26379") == [("[::1]", 26379)]


@pytest.mark.parametrize("bad", ["sentinel-0", ":26379", "sentinel-0:", "host:abc"])
def test_parse_sentinels_rejects_malformed_entries(bad: str) -> None:
    with pytest.raises(ValueError, match=r"expected host:port|port is not a number"):
        parse_sentinels(bad)


# ---------------------------------------------------------------------------
# System checks
# ---------------------------------------------------------------------------


@override_settings(VALKEY_SENTINELS_RAW="")
def test_check_is_silent_in_single_endpoint_mode() -> None:
    """Single-endpoint mode emits nothing at all — not even the experimental notice."""
    assert check_valkey_topology() == []


@override_settings(**sentinel_settings(VALKEY_MASTER_NAME=""))
def test_check_errors_when_master_name_missing() -> None:
    ids = [m.id for m in check_valkey_topology()]
    assert "trueppm.valkey.E001" in ids


@override_settings(**sentinel_settings(VALKEY_SENTINELS_RAW="not-a-host-port"))
def test_check_errors_on_malformed_sentinel_list() -> None:
    messages = check_valkey_topology()
    assert [m.id for m in messages] == ["trueppm.valkey.E002"]
    assert "not-a-host-port" in messages[0].msg


@override_settings(**sentinel_settings(), REDIS_URL="redis://somewhere-else:6379")
def test_check_warns_when_redis_url_is_shadowed_by_sentinel_mode() -> None:
    ids = [m.id for m in check_valkey_topology()]
    assert "trueppm.valkey.W001" in ids


@override_settings(**sentinel_settings(), REDIS_URL="redis://redis:6379")
def test_check_is_clean_for_a_correct_sentinel_block() -> None:
    """No errors or warnings — only the experimental-status notice."""
    assert [m.id for m in check_valkey_topology()] == ["trueppm.valkey.I001"]


@override_settings(**sentinel_settings(), REDIS_URL="redis://redis:6379")
def test_experimental_notice_is_info_not_warning() -> None:
    """Info level so `check --deploy --fail-level WARNING` does not fail a deploy."""
    from django.core.checks import Info

    notice = next(m for m in check_valkey_topology() if m.id == "trueppm.valkey.I001")
    assert isinstance(notice, Info)
    assert "EXPERIMENTAL" in notice.msg


def test_check_is_registered_with_django() -> None:
    from django.core.checks import registry

    assert check_valkey_topology in registry.registry.get_checks()


# ---------------------------------------------------------------------------
# Factory — single-endpoint mode preserves the pre-#2554 shape
# ---------------------------------------------------------------------------


@override_settings(VALKEY_SENTINELS=[], REDIS_URL="redis://valkey:6379")
def test_single_endpoint_mode_is_not_sentinel_mode() -> None:
    assert valkey.sentinel_mode() is False


@override_settings(VALKEY_SENTINELS=[], REDIS_URL="redis://valkey:6379")
@pytest.mark.parametrize(
    ("db", "expected"),
    [
        (valkey.DB_CELERY, "redis://valkey:6379/0"),
        (valkey.DB_CHANNELS, "redis://valkey:6379/1"),
        (valkey.DB_CACHE, "redis://valkey:6379/2"),
        (valkey.DB_NOTIFICATIONS, "redis://valkey:6379/3"),
    ],
)
def test_url_for_matches_the_legacy_string_concatenation(db: int, expected: str) -> None:
    assert valkey.url_for(db) == expected


@override_settings(VALKEY_SENTINELS=[], REDIS_URL="redis://valkey:6379")
def test_single_endpoint_client_targets_the_requested_database() -> None:
    client = valkey.client(valkey.DB_NOTIFICATIONS, decode_responses=True)
    kwargs = client.connection_pool.connection_kwargs
    assert kwargs["db"] == valkey.DB_NOTIFICATIONS
    assert kwargs["host"] == "valkey"
    assert kwargs["decode_responses"] is True


@override_settings(VALKEY_SENTINELS=[], REDIS_URL="redis://valkey:6379")
def test_single_endpoint_pool_passes_through_extra_kwargs() -> None:
    """``export_health`` relies on socket timeouts reaching the connection."""
    pool = valkey.pool(valkey.DB_CACHE, decode_responses=True, socket_timeout=2)
    assert pool.connection_kwargs["socket_timeout"] == 2


# ---------------------------------------------------------------------------
# Factory — Sentinel mode
# ---------------------------------------------------------------------------


class _FakeSentinel:
    """Records the ``master_for`` call instead of dialing a real Sentinel."""

    def __init__(self, sentinels: list[tuple[str, int]], **kwargs: Any) -> None:
        self.sentinels = sentinels
        self.kwargs = kwargs
        self.master_for_calls: list[tuple[str, dict[str, Any]]] = []

    def master_for(self, service_name: str, **kwargs: Any) -> Any:
        self.master_for_calls.append((service_name, kwargs))
        return _FakeClient()


class _FakeClient:
    connection_pool = object()


@pytest.fixture
def fake_sentinel(monkeypatch: pytest.MonkeyPatch) -> list[_FakeSentinel]:
    """Patch the sync Sentinel class and capture every instance built."""
    built: list[_FakeSentinel] = []

    def factory(sentinels: list[tuple[str, int]], **kwargs: Any) -> _FakeSentinel:
        instance = _FakeSentinel(sentinels, **kwargs)
        built.append(instance)
        return instance

    monkeypatch.setattr("redis.sentinel.Sentinel", factory)
    return built


@override_settings(**sentinel_settings())
def test_sentinel_mode_is_detected_from_the_host_list() -> None:
    assert valkey.sentinel_mode() is True


@override_settings(**sentinel_settings())
def test_sentinel_client_resolves_the_master_for_the_requested_db(
    fake_sentinel: list[_FakeSentinel],
) -> None:
    valkey.client(valkey.DB_CACHE, decode_responses=True)

    assert len(fake_sentinel) == 1
    assert fake_sentinel[0].sentinels == SENTINELS
    name, kwargs = fake_sentinel[0].master_for_calls[0]
    assert name == "mymaster"
    assert kwargs["db"] == valkey.DB_CACHE
    assert kwargs["decode_responses"] is True


@override_settings(**sentinel_settings(VALKEY_PASSWORD="datapw", VALKEY_SENTINEL_PASSWORD="sentpw"))
def test_data_and_sentinel_passwords_go_to_different_places(
    fake_sentinel: list[_FakeSentinel],
) -> None:
    """A shared password would authenticate against the wrong tier and fail closed."""
    valkey.client(valkey.DB_CELERY)

    manager = fake_sentinel[0]
    assert manager.kwargs["password"] == "datapw"
    assert manager.kwargs["sentinel_kwargs"] == {"password": "sentpw"}
    _, master_kwargs = manager.master_for_calls[0]
    assert master_kwargs["password"] == "datapw"


@override_settings(**sentinel_settings(VALKEY_USE_TLS=True))
def test_tls_flag_reaches_the_data_node_connection(fake_sentinel: list[_FakeSentinel]) -> None:
    valkey.client(valkey.DB_CELERY)
    assert fake_sentinel[0].kwargs["ssl"] is True


@override_settings(**sentinel_settings())
def test_sentinel_manager_is_cached_but_master_for_is_not(
    fake_sentinel: list[_FakeSentinel],
) -> None:
    """Re-resolving the primary per call is what makes failover transparent."""
    valkey.client(valkey.DB_CACHE)
    valkey.client(valkey.DB_CELERY)

    assert len(fake_sentinel) == 1, "the Sentinel manager should be built once per process"
    assert len(fake_sentinel[0].master_for_calls) == 2, "each call must re-resolve the primary"


@override_settings(**sentinel_settings())
def test_reset_managers_lets_a_test_rebind_the_topology(
    fake_sentinel: list[_FakeSentinel],
) -> None:
    valkey.client(valkey.DB_CACHE)
    valkey.reset_managers()
    valkey.client(valkey.DB_CACHE)
    assert len(fake_sentinel) == 2


def test_sentinel_resolution_failure_is_a_redis_error() -> None:
    """The invariant that lets every migrated call site keep its failure posture.

    Twelve call sites guard Valkey access with ``except redis.RedisError`` and
    choose fail-open (throttles, export health — an outage must not become a DoS
    surface) or fail-closed (WS ticket consume). Sentinel introduces a new way to
    fail: the quorum is reachable but no primary can be resolved. If
    ``MasterNotFoundError`` were outside the ``RedisError`` hierarchy, every one of
    those handlers would silently stop catching and a failover would surface as an
    unhandled 500 instead of the intended degradation.
    """
    from redis.sentinel import MasterNotFoundError

    assert issubclass(MasterNotFoundError, redis.ConnectionError)
    assert issubclass(MasterNotFoundError, redis.RedisError)


# ---------------------------------------------------------------------------
# Cache backend
# ---------------------------------------------------------------------------


def test_sentinel_cache_client_binds_to_real_django_base() -> None:
    """Guards the two private Django names this backend subclasses (ADR-0716)."""
    assert issubclass(SentinelRedisCache, RedisCache)
    assert issubclass(_SentinelCacheClient, RedisCacheClient)
    assert hasattr(RedisCacheClient, "_get_connection_pool"), (
        "Django moved RedisCacheClient._get_connection_pool — valkey_cache must be updated"
    )


def test_sentinel_cache_selects_our_client_class() -> None:
    cache = SentinelRedisCache("", {})
    assert cache._class is _SentinelCacheClient


@override_settings(**sentinel_settings())
def test_sentinel_cache_pool_comes_from_the_factory(
    fake_sentinel: list[_FakeSentinel],
) -> None:
    """Reads and writes both resolve the primary — no replica split for cache."""
    client = _SentinelCacheClient([""])

    assert client._get_connection_pool(write=True) is not None
    assert client._get_connection_pool(write=False) is not None
    dbs = [kwargs["db"] for _, kwargs in fake_sentinel[0].master_for_calls]
    assert dbs == [valkey.DB_CACHE, valkey.DB_CACHE]


# ---------------------------------------------------------------------------
# Regression guard
# ---------------------------------------------------------------------------

# Matches a raw client built straight from the REDIS_URL setting, in any of the
# forms that existed before #2554 (sync, asyncio, pool, with or without an
# f-string database suffix).
_RAW_CLIENT_RE = re.compile(
    r"(from_url|ConnectionPool\.from_url)\(\s*f?[\"']?\{?settings\.REDIS_URL",
)

# core/valkey.py is the factory itself; settings/base.py holds the two legitimate
# URL-string entries (channel layer + Celery) that cannot take a client object.
_ALLOWED = {"core/valkey.py", "settings/base.py"}


def test_no_new_raw_redis_url_clients() -> None:
    """Every Valkey client must come from ``core.valkey`` (ADR-0716).

    A raw ``from_url(settings.REDIS_URL)`` pins the process to one host, which is
    invisible until a Sentinel failover — at which point that call site silently
    keeps talking to the dead primary, and most of them fail open.
    """
    src = pathlib.Path(__file__).resolve().parents[1] / "src" / "trueppm_api"
    offenders = [
        f"{path.relative_to(src)}:{i}"
        for path in src.rglob("*.py")
        if str(path.relative_to(src)).replace("\\", "/") not in _ALLOWED
        for i, line in enumerate(path.read_text().splitlines(), 1)
        if _RAW_CLIENT_RE.search(line)
    ]
    assert offenders == [], (
        "Build the client with trueppm_api.core.valkey.client()/pool()/async_client() "
        f"instead of a raw REDIS_URL: {offenders}"
    )
