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


_GUARD_KEY = "durations_guard"


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Fail an api:test shard when .test_durations has gone stale (#5084).

    ``tryfirst`` so this runs before pytest-split narrows ``items`` to one group:
    the share must be judged against the FULL collected set, or every shard would
    see a different denominator. Only active under ``--splits``, so plain local
    runs, ``-k`` runs and the api:test-durations job are untouched.

    Under xdist the controller does not collect; each worker does. A worker that
    raises here dies in an xdist INTERNALERROR that reads as an infra flake and
    never shows the message. So a worker instead deselects everything (no test runs
    against a stale baseline) and hands the message to the controller through
    ``workeroutput``, which reports it once and sets a clean exit status.
    """
    if not config.getoption("splits", default=None):
        return
    from pathlib import Path

    from tests._durations_coverage import check_durations_coverage

    message = check_durations_coverage(
        (item.nodeid for item in items), Path(config.getoption("durations_path"))
    )
    if not message:
        return
    if hasattr(config, "workeroutput"):
        config.workeroutput[_GUARD_KEY] = message
        items[:] = []
        return
    raise pytest.UsageError(message)


@pytest.hookimpl(optionalhook=True)
def pytest_testnodedown(node: object, error: object) -> None:
    """Controller side: remember the guard message a worker handed back."""
    message = getattr(node, "workeroutput", {}).get(_GUARD_KEY)
    if message:
        node.config._durations_guard_message = message  # type: ignore[attr-defined]


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session: pytest.Session) -> None:
    """Controller side: print the guard message once and exit with a usage error."""
    message = getattr(session.config, "_durations_guard_message", None)
    if not message:
        return
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    if reporter is not None:
        reporter.write_line(f"ERROR: {message}", red=True)
    session.exitstatus = pytest.ExitCode.USAGE_ERROR
