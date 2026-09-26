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
from trueppm_api.apps.projects.models import (
    Calendar,
    DeliveryMode,
    Dependency,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.scheduling.models import MonteCarloRun, ProjectForecastSnapshot
from trueppm_api.apps.scheduling.views import mc_latest_cache_key

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
class TestWhatIfLagDeltaCap:
    def test_lag_delta_table_over_request_cap_returns_400(
        self,
        member_client: APIClient,
        project: Project,
        long_task: Task,
        short_task: Task,
        settings: object,
    ) -> None:
        """Both what-if simulations run under MC_LAG_DELTA_CELL_CAP (#4129)."""
        tasks = [long_task, short_task]
        for i in range(4):
            tasks.append(Task.objects.create(project=project, name=f"X{i}", duration=5))
        for i in range(1, len(tasks)):
            Dependency.objects.create(predecessor=tasks[i - 1], successor=tasks[i], lag=i)
        settings.MC_LAG_DELTA_CELL_CAP = 10  # type: ignore[attr-defined]
        r = member_client.get(
            _url(project),
            {"task_id": str(long_task.pk), "duration_delta": 1, "n_simulations": 10},
        )
        assert r.status_code == 400, r.data
        assert "lag-delta table would exceed 10 cells" in str(r.data)


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
# CPM and the Monte Carlo bands move together, on every sampling branch (#3533)
# ---------------------------------------------------------------------------


def _velocity_history(project: Project) -> None:
    """Four closed sprints, mean 30 points over a two-week cadence.

    Gives the project the velocity signal a SCRUM task with story points needs to
    take the engine's *first* sampling branch, which reads neither ``duration`` nor
    the PERT triple.
    """
    rows = [
        (20, date(2025, 10, 6), date(2025, 10, 17)),
        (40, date(2025, 10, 20), date(2025, 10, 31)),
        (25, date(2025, 11, 3), date(2025, 11, 14)),
        (35, date(2025, 11, 17), date(2025, 11, 28)),
    ]
    for i, (points, start, finish) in enumerate(rows, start=1):
        Sprint.objects.create(
            project=project,
            name=f"Sprint {i}",
            state=SprintState.COMPLETED,
            start_date=start,
            finish_date=finish,
            committed_points=32,
            completed_points=points,
        )


@pytest.mark.django_db
class TestWhatIfMovesCpmAndBandsTogether:
    """The deterministic finish and the probabilistic bands must agree that the
    perturbation happened (#3533).

    The engine picks a task's sampled duration by priority — velocity, then the
    three-point PERT triple, then the deterministic duration — and the what-if used
    to shift only the last two. For a SCRUM task on a project with velocity signal
    the CPM finish moved while P50/P80/P95 returned a flat zero delta, and the
    response reported both: an MCP client reads that as ground truth that a proposed
    slip carries no schedule risk. One test per branch, because the shipped bug was
    exactly "two of the three branches covered".
    """

    def test_velocity_sampled_scrum_task(self, member_client: APIClient, project: Project) -> None:
        """The branch that was silently unreachable.

        ``duration=1`` against a ~55-point backlog keeps the sampled-column floor
        (which clamps every sample up to the deterministic duration) well clear of
        the velocity draws, so the bands here can only move if the perturbation
        reached the input the velocity branch actually reads.
        """
        _velocity_history(project)
        task = Task.objects.create(
            project=project,
            name="Story",
            duration=1,
            story_points=55,
            delivery_mode=DeliveryMode.SCRUM,
        )

        r = member_client.get(
            _url(project),
            {"task_id": str(task.pk), "duration_delta": 20, "n_simulations": 400},
        )
        assert r.status_code == 200, r.data
        deltas = r.data["delta_vs_current"]
        assert deltas["cpm_finish"] > 0, deltas
        for band in ("p50", "p80", "p95"):
            assert deltas[band] > 0, f"{band} did not move with the CPM finish: {deltas}"

    def test_three_point_estimated_task(self, member_client: APIClient, project: Project) -> None:
        task = Task.objects.create(
            project=project,
            name="Estimated",
            duration=10,
            optimistic_duration=8,
            most_likely_duration=10,
            pessimistic_duration=20,
        )

        r = member_client.get(
            _url(project),
            {"task_id": str(task.pk), "duration_delta": 10, "n_simulations": 400},
        )
        assert r.status_code == 200, r.data
        deltas = r.data["delta_vs_current"]
        assert deltas["cpm_finish"] > 0, deltas
        for band in ("p50", "p80", "p95"):
            assert deltas[band] > 0, f"{band} did not move with the CPM finish: {deltas}"

    def test_deterministic_task(
        self, member_client: APIClient, project: Project, long_task: Task
    ) -> None:
        r = member_client.get(
            _url(project),
            {"task_id": str(long_task.pk), "duration_delta": 10, "n_simulations": 400},
        )
        assert r.status_code == 200, r.data
        deltas = r.data["delta_vs_current"]
        assert deltas["cpm_finish"] > 0, deltas
        for band in ("p50", "p80", "p95"):
            assert deltas[band] > 0, f"{band} did not move with the CPM finish: {deltas}"

    def test_a_zero_delta_moves_neither(self, member_client: APIClient, project: Project) -> None:
        """The other half of the invariant. Both runs share a fixed seed, so a flat
        band here is the absence of a perturbation, not RNG noise cancelling out."""
        _velocity_history(project)
        task = Task.objects.create(
            project=project,
            name="Story",
            duration=1,
            story_points=55,
            delivery_mode=DeliveryMode.SCRUM,
        )

        r = member_client.get(
            _url(project),
            {"task_id": str(task.pk), "duration_delta": 0, "n_simulations": 400},
        )
        assert r.status_code == 200, r.data
        assert r.data["delta_vs_current"] == {"p50": 0, "p80": 0, "p95": 0, "cpm_finish": 0}


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
        cache_key = mc_latest_cache_key(project.pk)
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

    def test_story_points_are_not_persisted(
        self,
        member_client: APIClient,
        project: Project,
    ) -> None:
        """A velocity-sampled task is perturbed through its ``story_points`` (#3533),
        which is a *committed backlog* number a team reads off the board — so the
        in-memory shift must not reach the row."""
        _velocity_history(project)
        task = Task.objects.create(
            project=project,
            name="Story",
            duration=1,
            story_points=55,
            delivery_mode=DeliveryMode.SCRUM,
        )

        r = member_client.get(
            _url(project),
            {"task_id": str(task.pk), "duration_delta": 20, "n_simulations": 50},
        )
        assert r.status_code == 200, r.data

        task.refresh_from_db()
        assert task.story_points == 55
        assert task.duration == 1


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

    @pytest.mark.parametrize("delta", [10**9, 10**12, 10**400])
    def test_absurd_duration_delta_returns_400_not_500(
        self, member_client: APIClient, project: Project, long_task: Task, delta: int
    ) -> None:
        """``duration_delta`` is an unbounded signed integer on the wire, so the
        perturbation is the first thing a hostile value reaches.

        Each magnitude overflows at a different layer — ``timedelta``'s day cap, the
        C int behind it, and float conversion of the story-point shift — and all three
        must surface as the documented 400, not an unhandled 500. This is why the
        perturbation runs inside the view's ``OverflowError`` guard rather than ahead
        of it.
        """
        r = member_client.get(
            _url(project),
            {"task_id": str(long_task.pk), "duration_delta": delta, "n_simulations": 10},
        )
        assert r.status_code == 400, r.data

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
