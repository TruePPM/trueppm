"""Tests for GET /api/v1/projects/<pk>/monte-carlo/whatif/ (#993).

The what-if endpoint perturbs one task's duration and recomputes the CPM + Monte
Carlo forecast entirely in memory, returning the current vs perturbed forecast,
whether the critical path changed, and the signed deltas — persisting nothing.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling.models import MonteCarloRun, ProjectForecastSnapshot

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_throttle_cache() -> object:
    """The what-if throttle history lives in the LocMem cache; clear it around each
    test so the 6/min scope never leaves a later test pre-throttled."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="whatif_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="What-If Project", start_date=date(2026, 1, 5), calendar=calendar
    )


@pytest.fixture
def long_task(project: Project) -> Task:
    """The critical (longest) task — a deterministic 10-day task with no successors."""
    return Task.objects.create(project=project, name="Long", duration=10)


@pytest.fixture
def short_task(project: Project) -> Task:
    """A parallel, non-critical 3-day task."""
    return Task.objects.create(project=project, name="Short", duration=3)


@pytest.fixture
def member_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/monte-carlo/whatif/"


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestWhatIfHappyPath:
    def test_slipping_critical_task_pushes_forecast_later(
        self,
        member_client: APIClient,
        project: Project,
        long_task: Task,
        short_task: Task,
    ) -> None:
        """A positive duration_delta on the critical task pushes every percentile and
        the CPM finish later; the critical path (a single longest task) is unchanged."""
        r = member_client.get(
            _url(project),
            {"task_id": str(long_task.pk), "duration_delta": 5, "n_simulations": 100},
        )
        assert r.status_code == 200, r.data
        body = r.data
        assert body["task_id"] == str(long_task.pk)
        assert body["applied"] == {
            "base_duration_days": 10,
            "duration_delta_days": 5,
            "new_duration_days": 15,
        }
        # Deterministic tasks => flat MC band equal to the CPM finish; a +5-day slip
        # moves all of them later (positive = worse).
        for key in ("p50", "p80", "p95", "cpm_finish"):
            assert body["delta_vs_current"][key] > 0
        assert body["whatif"]["cpm_finish"] > body["current"]["cpm_finish"]
        assert body["critical_path_changed"] is False
        assert body["runs"] == 100
        assert str(long_task.pk) in body["current"]["critical_path"]

    def test_new_duration_absolute_form(
        self,
        member_client: APIClient,
        project: Project,
        long_task: Task,
        short_task: Task,
    ) -> None:
        """new_duration sets the absolute duration; the endpoint reports the implied
        signed delta versus the task's current duration."""
        r = member_client.get(
            _url(project),
            {"task_id": str(long_task.pk), "new_duration": 4, "n_simulations": 50},
        )
        assert r.status_code == 200, r.data
        assert r.data["applied"] == {
            "base_duration_days": 10,
            "duration_delta_days": -6,
            "new_duration_days": 4,
        }
        # Shrinking the critical task from 10 to 4 pulls the finish in (negative delta).
        assert r.data["delta_vs_current"]["cpm_finish"] < 0

    def test_critical_path_flips_when_short_task_overtakes(
        self,
        member_client: APIClient,
        project: Project,
        long_task: Task,
        short_task: Task,
    ) -> None:
        """Slipping the short parallel task past the long one flips the critical path,
        so critical_path_changed is True."""
        r = member_client.get(
            _url(project),
            {"task_id": str(short_task.pk), "duration_delta": 20, "n_simulations": 50},
        )
        assert r.status_code == 200, r.data
        assert r.data["critical_path_changed"] is True
        # The short task now dominates the finish.
        assert str(short_task.pk) in r.data["whatif"]["critical_path"]

    def test_viewer_can_read(
        self,
        db: object,
        project: Project,
        long_task: Task,
    ) -> None:
        """Read access (Viewer) is sufficient — this is a non-mutating compute."""
        viewer = User.objects.create_user(username="whatif_viewer", password="pw")
        ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
        c = APIClient()
        c.force_authenticate(user=viewer)
        r = c.get(_url(project), {"task_id": str(long_task.pk), "duration_delta": 1})
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Non-mutation guarantee
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestWhatIfNonMutating:
    def test_nothing_is_persisted(
        self,
        member_client: APIClient,
        project: Project,
        long_task: Task,
    ) -> None:
        """The DB and cache are untouched: the task keeps its duration, no
        MonteCarloRun / ProjectForecastSnapshot rows are written, and the mc_latest
        cache stays empty."""
        assert MonteCarloRun.objects.count() == 0
        assert ProjectForecastSnapshot.objects.count() == 0
        cache_key = f"mc_latest:{project.pk}"
        assert cache.get(cache_key) is None

        r = member_client.get(
            _url(project),
            {"task_id": str(long_task.pk), "duration_delta": 7, "n_simulations": 50},
        )
        assert r.status_code == 200

        long_task.refresh_from_db()
        assert long_task.duration == 10  # unchanged
        assert MonteCarloRun.objects.count() == 0
        assert ProjectForecastSnapshot.objects.count() == 0
        assert cache.get(cache_key) is None


# ---------------------------------------------------------------------------
# Validation / permission errors
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestWhatIfErrors:
    def test_unauthenticated_returns_401(self, project: Project, long_task: Task) -> None:
        c = APIClient()
        r = c.get(_url(project), {"task_id": str(long_task.pk), "duration_delta": 1})
        assert r.status_code == 401

    def test_non_member_returns_403(self, db: object, project: Project, long_task: Task) -> None:
        outsider = User.objects.create_user(username="whatif_outsider", password="pw")
        c = APIClient()
        c.force_authenticate(user=outsider)
        r = c.get(_url(project), {"task_id": str(long_task.pk), "duration_delta": 1})
        assert r.status_code == 403

    def test_missing_project_returns_404(self, member_client: APIClient) -> None:
        r = member_client.get(
            "/api/v1/projects/00000000-0000-0000-0000-000000000000/monte-carlo/whatif/",
            {"task_id": "00000000-0000-0000-0000-000000000001", "duration_delta": 1},
        )
        assert r.status_code == 404

    def test_unknown_task_id_returns_400(
        self, member_client: APIClient, project: Project, long_task: Task
    ) -> None:
        r = member_client.get(
            _url(project),
            {"task_id": "00000000-0000-0000-0000-000000000009", "duration_delta": 1},
        )
        assert r.status_code == 400
        assert "committed task" in r.data["detail"]

    def test_task_from_another_project_returns_400(
        self,
        member_client: APIClient,
        project: Project,
        long_task: Task,
        calendar: Calendar,
    ) -> None:
        """A task id that belongs to a different project is rejected — single-project
        scope (ADR-0090), and no cross-project leakage."""
        other = Project.objects.create(name="Other", start_date=date(2026, 1, 5), calendar=calendar)
        other_task = Task.objects.create(project=other, name="Other T", duration=4)
        r = member_client.get(_url(project), {"task_id": str(other_task.pk), "duration_delta": 1})
        assert r.status_code == 400

    def test_both_delta_and_new_duration_returns_400(
        self, member_client: APIClient, project: Project, long_task: Task
    ) -> None:
        r = member_client.get(
            _url(project),
            {"task_id": str(long_task.pk), "duration_delta": 2, "new_duration": 5},
        )
        assert r.status_code == 400

    def test_neither_delta_nor_new_duration_returns_400(
        self, member_client: APIClient, project: Project, long_task: Task
    ) -> None:
        r = member_client.get(_url(project), {"task_id": str(long_task.pk)})
        assert r.status_code == 400

    def test_milestone_target_returns_400(self, member_client: APIClient, project: Project) -> None:
        milestone = Task.objects.create(project=project, name="Gate", duration=0, is_milestone=True)
        r = member_client.get(_url(project), {"task_id": str(milestone.pk), "duration_delta": 3})
        assert r.status_code == 400
        assert "milestone" in r.data["detail"].lower()

    def test_cap_exceeded_returns_402(
        self,
        member_client: APIClient,
        project: Project,
        long_task: Task,
        settings: object,
    ) -> None:
        settings.MC_SIMULATION_CAP = 100  # type: ignore[attr-defined]
        r = member_client.get(
            _url(project),
            {"task_id": str(long_task.pk), "duration_delta": 1, "n_simulations": 101},
        )
        assert r.status_code == 402
        assert r.data["error"] == "simulation_cap_exceeded"


# ---------------------------------------------------------------------------
# Throttle
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestWhatIfThrottle:
    def test_exceeding_rate_returns_429(
        self,
        member_client: APIClient,
        project: Project,
        long_task: Task,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The what-if scope bounds a single member's call rate (it runs 2x CPM + 2x
        MC per call). Patch the rate on the class — DRF binds THROTTLE_RATES at import,
        so a settings override never reaches the already-bound throttle."""
        monkeypatch.setattr(
            ScopedRateThrottle,
            "THROTTLE_RATES",
            {**ScopedRateThrottle.THROTTLE_RATES, "monte_carlo_whatif": "2/min"},
        )
        cache.clear()
        statuses = [
            member_client.get(
                _url(project),
                {"task_id": str(long_task.pk), "duration_delta": 1, "n_simulations": 10},
            ).status_code
            for _ in range(3)
        ]
        assert statuses == [200, 200, 429]
