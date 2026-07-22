"""Tests for the dependency-aware readiness probe (#1894).

Covers:
  - GET /api/v1/readyz is reachable UNAUTHENTICATED (kubelet has no credential)
  - 200 + all-ok checks when the database, cache, and migrations are all healthy
  - 503 when the cache probe fails
  - 503 when the database probe fails
  - 503 when migrations are unapplied/in-flight (#2217)
  - the body leaks no infrastructure detail — only coarse ok/fail per dependency
  - the selector helpers probe DB, cache, and migrations independently
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

URL = "/api/v1/readyz"


@pytest.mark.django_db
class TestReadyzEndpoint:
    def test_unauthenticated_and_healthy_returns_200(self) -> None:
        # No force_authenticate: the probe must answer without any credential.
        # The test database has every migration applied, so the migration check
        # is "ok" alongside the DB and cache round-trips.
        res = APIClient().get(URL)
        assert res.status_code == 200
        assert res.data["status"] == "ok"
        assert res.data["checks"] == {"database": "ok", "cache": "ok", "migrations": "ok"}

    def test_cache_failure_returns_503(self) -> None:
        with patch("trueppm_api.apps.observability.selectors._probe_cache", return_value=False):
            res = APIClient().get(URL)
        assert res.status_code == 503
        assert res.data["status"] == "fail"
        assert res.data["checks"]["cache"] == "fail"
        assert res.data["checks"]["database"] == "ok"

    def test_database_failure_returns_503(self) -> None:
        with patch("trueppm_api.apps.observability.selectors._probe_database", return_value=False):
            res = APIClient().get(URL)
        assert res.status_code == 503
        assert res.data["status"] == "fail"
        assert res.data["checks"]["database"] == "fail"

    def test_unapplied_migration_returns_503(self) -> None:
        """A pod with unapplied/in-flight migrations must report not-ready (#2217).

        Simulates the rolling-upgrade window where the image's code carries
        migrations the connected database has not applied yet — the pod is up but
        its schema and code disagree, so it must be kept out of the Service.
        """
        with patch(
            "trueppm_api.apps.observability.selectors._probe_migrations", return_value=False
        ):
            res = APIClient().get(URL)
        assert res.status_code == 503
        assert res.data["status"] == "fail"
        assert res.data["checks"]["migrations"] == "fail"
        # DB and cache are still healthy — only the migration gate is closed.
        assert res.data["checks"]["database"] == "ok"
        assert res.data["checks"]["cache"] == "ok"

    def test_body_leaks_no_infrastructure_detail(self) -> None:
        """A failing probe must expose only 'fail', never a connection string/host."""
        with patch("trueppm_api.apps.observability.selectors._probe_cache", return_value=False):
            res = APIClient().get(URL)
        # Values are the coarse literals only — nothing host/DSN-shaped.
        assert set(res.data["checks"].values()) <= {"ok", "fail"}


@pytest.mark.django_db
class TestReadinessSelectors:
    def test_probe_database_true_when_db_up(self) -> None:
        from trueppm_api.apps.observability.selectors import _probe_database

        assert _probe_database() is True

    def test_probe_cache_true_when_cache_up(self) -> None:
        from trueppm_api.apps.observability.selectors import _probe_cache

        assert _probe_cache() is True

    def test_probe_cache_false_on_backend_error(self) -> None:
        from trueppm_api.apps.observability.selectors import _probe_cache

        with patch("django.core.cache.cache.set", side_effect=ConnectionError("cache down")):
            assert _probe_cache() is False

    def test_probe_migrations_true_when_all_applied(self) -> None:
        from trueppm_api.apps.observability.selectors import _probe_migrations

        # The pytest-django test database is migrated to the leaf, so the plan
        # is empty and the probe reports ready.
        assert _probe_migrations() is True

    def test_probe_migrations_false_when_plan_nonempty(self) -> None:
        """A non-empty migration plan (unapplied/in-flight) means not-ready."""
        from django.db.migrations.executor import MigrationExecutor

        from trueppm_api.apps.observability.selectors import _probe_migrations

        # Simulate an outstanding migration: the executor returns a non-empty
        # plan, so the probe must report not-ready. Patching migration_plan on
        # the class covers the function-local import inside the probe.
        with patch.object(
            MigrationExecutor, "migration_plan", return_value=[("app", "0002_pending")]
        ):
            assert _probe_migrations() is False

    def test_probe_migrations_false_on_error(self) -> None:
        """Any executor error is swallowed into not-ready, like the DB/cache probes."""
        from django.db.migrations.executor import MigrationExecutor

        from trueppm_api.apps.observability.selectors import _probe_migrations

        with patch.object(
            MigrationExecutor, "migration_plan", side_effect=RuntimeError("loader blew up")
        ):
            assert _probe_migrations() is False

    def test_get_readiness_reports_per_dependency(self) -> None:
        from trueppm_api.apps.observability.selectors import get_readiness

        ready, checks = get_readiness()
        assert ready is True
        assert checks == {"database": "ok", "cache": "ok", "migrations": "ok"}
