"""Tests for the dependency-aware readiness probe (#1894).

Covers:
  - GET /api/v1/readyz is reachable UNAUTHENTICATED (kubelet has no credential)
  - 200 + all-ok checks when the database and cache are both live
  - 503 when the cache probe fails
  - 503 when the database probe fails
  - the body leaks no infrastructure detail — only coarse ok/fail per dependency
  - the selector helpers probe DB and cache independently
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
        res = APIClient().get(URL)
        assert res.status_code == 200
        assert res.data["status"] == "ok"
        assert res.data["checks"] == {"database": "ok", "cache": "ok"}

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

    def test_get_readiness_reports_per_dependency(self) -> None:
        from trueppm_api.apps.observability.selectors import get_readiness

        ready, checks = get_readiness()
        assert ready is True
        assert checks == {"database": "ok", "cache": "ok"}
