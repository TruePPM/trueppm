"""Root pytest configuration — starts testcontainers PostgreSQL before Django setup.

This file MUST live at the rootdir (packages/api/conftest.py, next to pyproject.toml)
so it is loaded before pytest-django's pytest_load_initial_conftests hook configures
Django.  The nested tests/conftest.py runs too late because pytest-django reads
DJANGO_SETTINGS_MODULE (and force-loads settings) inside pytest_load_initial_conftests,
which fires after conftest files in sub-directories are processed.
"""

from __future__ import annotations

import os

import pytest


@pytest.hookimpl(tryfirst=True)
def pytest_configure(config: pytest.Config) -> None:
    """Start testcontainers PostgreSQL when DATABASE_URL is not already set.

    In CI, DATABASE_URL is injected by the GitLab service block.  Locally,
    we spin up a container and export the URL so Django settings read it.
    """
    if os.environ.get("DATABASE_URL"):
        return

    from testcontainers.postgres import PostgresContainer  # type: ignore[import-untyped]

    container = PostgresContainer("postgres:16-alpine")
    container.start()
    # django-environ on older versions needs plain postgresql://, not +psycopg2
    url = container.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
    os.environ["DATABASE_URL"] = url
