"""Pytest configuration — PostgreSQL via CI service or testcontainers for local dev."""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest


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
