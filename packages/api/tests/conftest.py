"""Pytest configuration — PostgreSQL via CI service or testcontainers for local dev."""

from __future__ import annotations

import os


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
