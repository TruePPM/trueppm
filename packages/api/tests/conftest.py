"""Pytest configuration — PostgreSQL via CI service or testcontainers for local dev."""

from __future__ import annotations

import os
import socket
from collections.abc import Iterator
from urllib.parse import urlsplit

import pytest
from pytest_socket import enable_socket, socket_allow_hosts


def _resolve(host: str) -> set[str]:
    """Return ``host`` plus every IP it resolves to (empty on resolution failure).

    ``pytest-socket``'s ``allow_hosts`` matches the address literally passed to
    ``socket.connect()`` — for a TCP connection that is the *resolved IP*, not the
    hostname. So an allowlist built from a hostname (CI's ``postgres`` / ``valkey``
    service aliases) must carry the resolved IPs too, or the DB connect is blocked.
    Resolution uses ``getaddrinfo``, which pytest-socket does not intercept.
    """
    resolved = {host}
    try:
        for info in socket.getaddrinfo(host, None):
            resolved.add(info[4][0])
    except OSError:
        # Unresolvable at collection time (e.g. a service alias not yet in
        # /etc/hosts) — keep the literal name; a later connect still matches it
        # if resolution succeeds by then.
        pass
    return resolved


@pytest.fixture(scope="session")
def _socket_allowed_hosts() -> list[str]:
    """Infrastructure hosts the socket ban permits: the test DB, Redis, loopback.

    Derived from Django settings so the same code works in CI (``postgres`` /
    ``valkey`` service aliases) and locally (``127.0.0.1`` via testcontainers)
    without a hardcoded host. Everything *not* on this list — an external webhook
    URL, a cloud metadata IP (#1652), any unmocked outbound call — is blocked.
    """
    from django.conf import settings

    allowed: set[str] = {"127.0.0.1", "::1", "localhost"}
    for db in settings.DATABASES.values():
        host = str(db.get("HOST") or "").strip()
        if host:  # empty HOST = a local unix socket, covered by allow_unix_socket
            allowed |= _resolve(host)
    redis_host = urlsplit(str(getattr(settings, "REDIS_URL", ""))).hostname
    if redis_host:
        allowed |= _resolve(redis_host)
    return sorted(allowed)


@pytest.fixture(autouse=True)
def _ban_external_sockets(
    request: pytest.FixtureRequest, _socket_allowed_hosts: list[str]
) -> Iterator[None]:
    """Fail fast when a test opens a *real* outbound socket to a non-infra host (#1653).

    A non-hermetic test — one whose mock is misdirected and reaches the live
    network — hangs on the connect timeout and flakes order-dependently in CI (the
    #1652 webhook-SSRF incident: a real 10s connect to ``169.254.169.254``). This
    autouse guard turns that into an instant, deterministic ``SocketBlockedError``
    at author time. Connections to the configured DB / Redis hosts are allowed so
    the ORM and any legitimately-networked fixture still work; unix sockets are
    allowed so local IPC is unaffected.

    A test that genuinely needs the network opts out explicitly and reviewably with
    ``@pytest.mark.enable_socket``.
    """
    if request.node.get_closest_marker("enable_socket"):
        yield
        return
    socket_allow_hosts(_socket_allowed_hosts, allow_unix_socket=True)
    try:
        yield
    finally:
        # Restore the real socket for teardown / the next test's setup, so fixture
        # finalizers and pytest-django's DB handling are never caught by the ban.
        enable_socket()


@pytest.fixture(autouse=True)
def _reset_throttle_cache() -> Iterator[None]:
    """Clear the throttle counter cache after every test (#1080).

    The global ``DEFAULT_THROTTLE_CLASSES`` (probe-exempt anon/user) is active under
    the dev settings pytest uses, backed by ``LocMemCache``, so one test's request
    counts would otherwise persist into the next within the same worker — the anon
    scope shares a single ``127.0.0.1`` bucket, which would surface as an
    order-dependent 429 flake. Clearing at teardown resets the counters between tests
    without ever wiping a test's own setup (the clear runs after the test body).
    """
    yield
    from django.core.cache import cache

    cache.clear()


def pytest_configure(config: object) -> None:
    """Start a testcontainers PostgreSQL instance when DATABASE_URL is not set.

    In CI, DATABASE_URL is injected by the GitLab service block and django-environ
    picks it up from settings/dev.py.  Locally, we spin up a container and export
    the URL so that django-environ reads the same variable — pytest-django's built-in
    django_db_setup then creates the test database and runs migrations as normal.
    """
    if os.environ.get("DATABASE_URL"):
        return

    from testcontainers.postgres import PostgresContainer  # type: ignore[import-untyped]

    container = PostgresContainer("postgres:16-alpine")
    container.start()
    os.environ["DATABASE_URL"] = container.get_connection_url()
    # Container lives for the process; no explicit stop needed.
