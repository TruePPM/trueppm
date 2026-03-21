"""Pytest configuration — PostgreSQL via CI service or testcontainers for local dev."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="session")
def django_db_setup(django_test_environment: object) -> None:
    """Point Django's test database at PostgreSQL.

    In CI, DATABASE_URL is set by the GitLab service block.
    Locally, we spin up a testcontainers PostgreSQL instance.
    """
    from django.conf import settings

    if os.environ.get("DATABASE_URL"):
        # CI: DATABASE_URL already set; django-environ in settings/dev.py parsed it.
        return

    # Local: start a PostgreSQL container.
    from testcontainers.postgres import PostgresContainer

    container = PostgresContainer("postgres:16-alpine")
    container.start()
    settings.DATABASES["default"] = {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": container.dbname,
        "USER": container.username,
        "PASSWORD": container.password,
        "HOST": container.get_container_host_ip(),
        "PORT": container.get_exposed_port(5432),
        "CONN_MAX_AGE": 0,
    }
    # Container lives for the session; no cleanup needed (process exit stops it).
