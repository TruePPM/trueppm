"""Tests for GET /api/v1/projects/<pk>/monte-carlo/latest/ (issue #172)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    """Ensure no stale MC cache entries bleed between tests."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="mc_latest_user", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="mc_latest_other", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="MC Latest Project", start_date=date(2026, 1, 5), calendar=calendar
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
def member_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def scheduler_client(project: Project) -> APIClient:
    scheduler = User.objects.create_user(username="mc_latest_scheduler", password="pw")
    ProjectMembership.objects.create(project=project, user=scheduler, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=scheduler)
    return c


@pytest.fixture
def anon_client() -> APIClient:
    return APIClient()


# ---------------------------------------------------------------------------
# GET /api/v1/projects/<pk>/monte-carlo/latest/
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestMonteCarloLatest:
    def url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/monte-carlo/latest/"

    def mc_url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/monte-carlo/"

    def test_returns_404_when_no_cache(self, member_client: APIClient, project: Project) -> None:
        res = member_client.get(self.url(project.pk))
        assert res.status_code == 404
        assert "detail" in res.json()

    def test_unauthenticated_returns_401(
        self, anon_client: APIClient, project: Project, member_client: object
    ) -> None:
        res = anon_client.get(self.url(project.pk))
        assert res.status_code == 401

    def test_non_member_returns_403(
        self, other_user: object, project: Project, member_client: object
    ) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.get(self.url(project.pk))
        assert res.status_code == 403

    def test_returns_result_after_simulation_run(
        self, member_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        # Run the simulation so the cache is populated
        run_res = member_client.post(self.mc_url(project.pk), {"n_simulations": 100}, format="json")
        assert run_res.status_code == 200

        latest_res = member_client.get(self.url(project.pk))
        assert latest_res.status_code == 200
        data = latest_res.json()
        assert "p50" in data
        assert "p80" in data
        assert "p95" in data
        assert "histogram_buckets" in data
        assert isinstance(data["histogram_buckets"], list)

    def test_histogram_buckets_have_date_and_count(
        self, member_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        member_client.post(self.mc_url(project.pk), {"n_simulations": 100}, format="json")
        data = member_client.get(self.url(project.pk)).json()
        for bucket in data["histogram_buckets"]:
            assert "date" in bucket
            assert "count" in bucket
            assert isinstance(bucket["count"], int)

    def test_unknown_project_returns_404(
        self, member_client: APIClient, member_client_fixture: None = None
    ) -> None:
        import uuid

        res = member_client.get(self.url(uuid.uuid4()))
        assert res.status_code == 404

    def test_response_includes_last_run_at_iso_timestamp(
        self, member_client: APIClient, project: Project, pert_task: Task
    ) -> None:
        """Issue #335 — surfaces forecast freshness on Overview / Schedule.

        Captured at cache-write time so the timestamp always reflects the most
        recent successful simulation, not the cache read.
        """
        from datetime import datetime

        member_client.post(self.mc_url(project.pk), {"n_simulations": 100}, format="json")
        data = member_client.get(self.url(project.pk)).json()
        assert "last_run_at" in data
        # ISO 8601 — fromisoformat tolerates both naive and tz-aware strings.
        parsed = datetime.fromisoformat(data["last_run_at"])
        assert parsed is not None

    # ── #987 — cpm_finish + delta_vs_cpm + confidence_curve ──────────────────

    def _scheduled_task(self, project: Project) -> Task:
        """A committed PERT task with a CPM finish so cpm_finish is non-null."""
        return Task.objects.create(
            project=project,
            name="Scheduled",
            duration=5,
            optimistic_duration=3,
            most_likely_duration=5,
            pessimistic_duration=10,
            early_start=date(2026, 1, 5),
            early_finish=date(2026, 1, 9),
        )

    def test_latest_includes_cpm_finish_and_delta_vs_cpm(
        self, member_client: APIClient, project: Project
    ) -> None:
        """cpm_finish (the deterministic spine) and the per-percentile premium
        over it are server-owned on the latest payload (#987), so a headless
        client reads the risk delta instead of subtracting dates."""
        self._scheduled_task(project)
        member_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")
        data = member_client.get(self.url(project.pk)).json()

        assert data["cpm_finish"] == "2026-01-09"
        delta = data["delta_vs_cpm"]
        assert set(delta) == {"p50", "p80", "p95"}
        # All deltas are integer calendar-day offsets vs the CPM finish, and the
        # band widens monotonically (p95 finishes no earlier than p50).
        for key in ("p50", "p80", "p95"):
            assert isinstance(delta[key], int)
        assert delta["p50"] <= delta["p95"]

    def test_confidence_curve_is_cumulative_and_tops_out_at_100(
        self, member_client: APIClient, project: Project
    ) -> None:
        """confidence_curve is a cumulative P(finish ≤ date) S-curve derived from
        the histogram buckets — non-decreasing, ending at 100% (#987)."""
        self._scheduled_task(project)
        member_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")
        curve = member_client.get(self.url(project.pk)).json()["confidence_curve"]

        assert isinstance(curve, list) and len(curve) >= 1
        prev = -1.0
        for point in curve:
            assert set(point) == {"date", "pct"}
            assert point["pct"] >= prev  # cumulative ⇒ never decreases
            prev = point["pct"]
        assert curve[-1]["pct"] == pytest.approx(100.0)

    def test_history_fallback_keeps_cpm_delta_and_persisted_curve(
        self, member_client: APIClient, scheduler_client: APIClient, project: Project
    ) -> None:
        """After the cache TTL expires the persisted run carries cpm_finish +
        delta_vs_cpm, and — as of #1231 — the persisted distribution too, so the
        confidence_curve + histogram survive cache expiry instead of falling back
        to empty (ADR-0144). The run is posted by a Scheduler because only
        Scheduler+ persists a history row (#1502); the fallback read stays open
        to every member."""
        self._scheduled_task(project)
        scheduler_client.post(self.mc_url(project.pk), {"n_simulations": 200}, format="json")
        cache.clear()  # simulate TTL expiry → history fallback path

        data = member_client.get(self.url(project.pk)).json()
        assert data["from_history"] is True
        assert data["cpm_finish"] == "2026-01-09"
        assert set(data["delta_vs_cpm"]) == {"p50", "p80", "p95"}
        # The distribution is now persisted on the run, so the curve + histogram
        # survive the TTL (the headline #1231 fix).
        assert data["confidence_curve"] != []
        assert data["histogram_buckets"] != []
