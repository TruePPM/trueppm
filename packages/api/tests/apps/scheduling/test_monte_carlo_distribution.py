"""Tests for persisted per-run Monte Carlo distribution (#1231, ADR-0144).

Covers: distribution persists on a real run-record; the serializer hides it
without ``expand_distribution`` and returns it with; the ``/latest/`` from-history
fallback returns persisted buckets after a cache miss; and the size guard
down-samples a payload that exceeds ``MC_DISTRIBUTION_MAX_BYTES`` while leaving the
cache copy untouched.
"""

from __future__ import annotations

import json
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling.models import MonteCarloRun
from trueppm_api.apps.scheduling.serializers import MonteCarloRunSerializer

User = get_user_model()


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def admin(db: object) -> object:
    return User.objects.create_user(username="mc_dist_admin", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="MC Dist Project", start_date=date(2026, 1, 5), calendar=calendar
    )


@pytest.fixture
def pert_task(project: Project) -> Task:
    return Task.objects.create(
        project=project,
        name="T1",
        duration=5,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=10,
    )


@pytest.fixture
def admin_client(admin: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


def run_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/"


def latest_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/latest/"


def history_url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/monte-carlo/history/"


@pytest.mark.django_db
class TestDistributionPersistsOnRun:
    def test_run_persists_distribution_payload(
        self, admin_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        res = admin_client.post(run_url(project.pk), {"n_simulations": 200}, format="json")
        assert res.status_code == 200
        run = MonteCarloRun.objects.filter(project=project).first()
        assert run is not None
        assert run.distribution is not None
        # Same shape as the cache payload / latest response.
        assert set(run.distribution) == {"histogram_buckets", "confidence_curve", "sensitivity"}
        assert run.distribution["histogram_buckets"]  # non-empty for a PERT task


@pytest.mark.django_db
class TestSerializerExpansion:
    def _make_run_with_dist(self, project: Project) -> MonteCarloRun:
        return MonteCarloRun.objects.create(
            project=project,
            p80=date(2026, 9, 1),
            n_simulations=100,
            distribution={
                "histogram_buckets": [{"date": "2026-09-01", "count": 100}],
                "confidence_curve": [{"date": "2026-09-01", "pct": 100.0}],
                "sensitivity": [],
            },
        )

    def test_distribution_hidden_without_expand(self, project: Project) -> None:
        run = self._make_run_with_dist(project)
        data = MonteCarloRunSerializer(run, context={}).data
        assert data["distribution"] is None

    def test_distribution_returned_with_expand(self, project: Project) -> None:
        run = self._make_run_with_dist(project)
        data = MonteCarloRunSerializer(run, context={"expand_distribution": True}).data
        assert data["distribution"] is not None
        assert data["distribution"]["histogram_buckets"][0]["count"] == 100

    def test_history_endpoint_expand_param(self, admin_client: APIClient, project: Project) -> None:
        self._make_run_with_dist(project)
        # Default: distribution suppressed.
        res = admin_client.get(history_url(project.pk))
        assert res.json()["results"][0]["distribution"] is None
        # ?expand=distribution opts in.
        res = admin_client.get(history_url(project.pk) + "?expand=distribution")
        assert res.json()["results"][0]["distribution"] is not None


@pytest.mark.django_db
class TestLatestFallbackReturnsPersistedDistribution:
    def test_latest_returns_persisted_buckets_after_cache_miss(
        self, admin_client: APIClient, project: Project
    ) -> None:
        MonteCarloRun.objects.create(
            project=project,
            p50=date(2026, 8, 20),
            p80=date(2026, 9, 1),
            p95=date(2026, 9, 12),
            n_simulations=250,
            distribution={
                "histogram_buckets": [{"date": "2026-09-01", "count": 250}],
                "confidence_curve": [{"date": "2026-09-01", "pct": 100.0}],
                "sensitivity": [{"task_id": "t1", "index": 0.9}],
            },
        )
        cache.clear()  # simulate TTL expiry
        data = admin_client.get(latest_url(project.pk)).json()
        assert data["from_history"] is True
        assert data["histogram_buckets"] == [{"date": "2026-09-01", "count": 250}]
        assert data["sensitivity"] == [{"task_id": "t1", "index": 0.9}]

    def test_latest_legacy_run_without_distribution_falls_back_empty(
        self, admin_client: APIClient, project: Project
    ) -> None:
        # Legacy run: no persisted distribution (no backfill) → empty arrays.
        MonteCarloRun.objects.create(
            project=project, p80=date(2026, 9, 1), n_simulations=100, distribution=None
        )
        cache.clear()
        data = admin_client.get(latest_url(project.pk)).json()
        assert data["from_history"] is True
        assert data["histogram_buckets"] == []
        assert data["confidence_curve"] == []


@pytest.mark.django_db
class TestSizeGuardDownSamples:
    def test_oversized_payload_is_downsampled_for_persist_only(
        self, admin_client: APIClient, project: Project, pert_task: Task, settings: object
    ) -> None:
        from trueppm_api.apps.scheduling.views import _distribution_for_persist

        # Build an oversized distribution with many buckets.
        def _d(i: int) -> str:
            return f"2026-09-{(i % 28) + 1:02d}"

        big = {
            "histogram_buckets": [{"date": _d(i), "count": i} for i in range(500)],
            "confidence_curve": [{"date": _d(i), "pct": i / 5.0} for i in range(500)],
            "sensitivity": [],
        }
        # Make the cap tiny so the guard must down-sample.
        settings.MC_DISTRIBUTION_MAX_BYTES = 4_096
        original_bucket_count = len(big["histogram_buckets"])

        persisted = _distribution_for_persist(big)

        # The persisted copy is bounded.
        assert len(json.dumps(persisted).encode()) <= settings.MC_DISTRIBUTION_MAX_BYTES
        assert len(persisted["histogram_buckets"]) < original_bucket_count
        # The caller's full payload (and the cache copy it feeds) is untouched.
        assert len(big["histogram_buckets"]) == original_bucket_count

    def test_small_payload_passes_through_unchanged(self, settings: object) -> None:
        from trueppm_api.apps.scheduling.views import _distribution_for_persist

        small = {
            "histogram_buckets": [{"date": "2026-09-01", "count": 10}],
            "confidence_curve": [{"date": "2026-09-01", "pct": 100.0}],
            "sensitivity": [],
        }
        out = _distribution_for_persist(small)
        assert out["histogram_buckets"] == small["histogram_buckets"]
