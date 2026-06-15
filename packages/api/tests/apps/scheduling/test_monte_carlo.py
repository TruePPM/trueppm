"""Tests for POST /api/v1/projects/<pk>/monte-carlo/."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="mc_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="MC Project", start_date=date(2026, 1, 5), calendar=calendar)


@pytest.fixture
def pert_task(project: Project) -> Task:
    """A task with three-point PERT estimates."""
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
def viewer_client(db: object, project: Project) -> APIClient:
    viewer = User.objects.create_user(username="mc_viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestMonteCarloEndpoint:
    def test_returns_200_with_percentiles(
        self,
        member_client: APIClient,
        project: Project,
        pert_task: Task,
    ) -> None:
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 100},
            format="json",
        )
        assert r.status_code == 200
        assert "p50" in r.data
        assert "p80" in r.data
        assert "p95" in r.data
        assert r.data["runs"] == 100

    def test_viewer_can_run_simulation(
        self,
        viewer_client: APIClient,
        project: Project,
        pert_task: Task,
    ) -> None:
        """Read access (Viewer) is sufficient; no write permission needed."""
        r = viewer_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 50},
            format="json",
        )
        assert r.status_code == 200

    def test_unauthenticated_returns_401(self, project: Project, pert_task: Task) -> None:
        c = APIClient()
        r = c.post(f"/api/v1/projects/{project.pk}/monte-carlo/", format="json")
        assert r.status_code == 401

    def test_non_member_returns_403(
        self,
        db: object,
        project: Project,
        pert_task: Task,
    ) -> None:
        outsider = User.objects.create_user(username="outsider_mc", password="pw")
        c = APIClient()
        c.force_authenticate(user=outsider)
        r = c.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 50},
            format="json",
        )
        assert r.status_code == 403

    def test_missing_project_returns_404(self, member_client: APIClient) -> None:
        r = member_client.post(
            "/api/v1/projects/00000000-0000-0000-0000-000000000000/monte-carlo/",
            format="json",
        )
        assert r.status_code == 404

    def test_cap_exceeded_returns_402(
        self,
        member_client: APIClient,
        project: Project,
        pert_task: Task,
        settings: object,
    ) -> None:
        """Requesting more sims than the cap returns 402 with structured body."""
        settings.MC_SIMULATION_CAP = 100  # type: ignore[attr-defined]
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 101},
            format="json",
        )
        assert r.status_code == 402
        assert r.data["error"] == "simulation_cap_exceeded"
        assert r.data["tier"] == "team"
        assert "message" in r.data

    def test_task_cap_exceeded_returns_402(
        self,
        member_client: APIClient,
        project: Project,
        settings: object,
    ) -> None:
        """Projects exceeding the task cap return 402."""
        # Create 3 tasks, set cap to 2.
        for i in range(3):
            Task.objects.create(project=project, name=f"T{i}", duration=1)
        settings.MC_TASK_CAP = 2  # type: ignore[attr-defined]
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 10},
            format="json",
        )
        assert r.status_code == 402
        assert r.data["error"] == "simulation_cap_exceeded"

    def test_defaults_to_cap_when_n_simulations_omitted(
        self,
        member_client: APIClient,
        project: Project,
        pert_task: Task,
        settings: object,
    ) -> None:
        """Omitting n_simulations defaults to MC_SIMULATION_CAP."""
        settings.MC_SIMULATION_CAP = 50  # type: ignore[attr-defined]
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            format="json",
        )
        assert r.status_code == 200
        assert r.data["runs"] == 50

    def test_no_tasks_returns_400(
        self,
        member_client: APIClient,
        project: Project,
    ) -> None:
        """Empty project (no tasks) returns 400."""
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 10},
            format="json",
        )
        assert r.status_code == 400

    def test_unlimited_cap_when_none(
        self,
        member_client: APIClient,
        project: Project,
        pert_task: Task,
        settings: object,
    ) -> None:
        """MC_SIMULATION_CAP=None allows any n_simulations (Enterprise)."""
        settings.MC_SIMULATION_CAP = None  # type: ignore[attr-defined]
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 2_000},
            format="json",
        )
        assert r.status_code == 200
        assert r.data["runs"] == 2_000

    def test_non_integer_n_simulations_returns_400(
        self,
        member_client: APIClient,
        project: Project,
        pert_task: Task,
    ) -> None:
        """#255: non-integer n_simulations returns 400, not a 500 from int() raise."""
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": "not-a-number"},
            format="json",
        )
        assert r.status_code == 400
        assert "integer" in r.data["detail"].lower()

    def test_zero_n_simulations_returns_400(
        self,
        member_client: APIClient,
        project: Project,
        pert_task: Task,
    ) -> None:
        """#255: zero n_simulations is rejected as not positive."""
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 0},
            format="json",
        )
        assert r.status_code == 400

    def test_null_n_simulations_returns_400(
        self,
        member_client: APIClient,
        project: Project,
        pert_task: Task,
    ) -> None:
        """#255: an explicit JSON null for n_simulations returns 400 (TypeError)."""
        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": None},
            format="json",
        )
        assert r.status_code == 400

    def test_simulation_honors_planned_start_floor(
        self,
        member_client: APIClient,
        project: Project,
    ) -> None:
        """#1185: MC must honor planned_start as a start-no-earlier-than floor,
        matching the deterministic CPM pass.

        The project starts 2026-01-05 but the only task is planned to start a
        month later (2026-02-02). With no dependency holding it, the simulated
        task must still not begin before its planned start — otherwise the
        forecast finishes before the deterministic CPM date, which is impossible.
        Before the fix, the MC input dropped planned_start and the task floated
        back to project.start_date, finishing in early January. The floor is now
        honored centrally by build_sched_tasks (shared with the CPM pass).
        """
        floor = date(2026, 2, 2)  # Monday, ~4 weeks after project start
        Task.objects.create(
            project=project,
            name="Floored",
            duration=5,
            planned_start=floor,
        )

        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 100},
            format="json",
        )
        assert r.status_code == 200

        # Deterministic network (no PERT/velocity) → every run is identical.
        assert r.data["p50"] == r.data["p80"] == r.data["p95"]
        # The finish cannot precede the planned-start floor.
        assert date.fromisoformat(r.data["p50"]) >= floor
        # And the forecast must not beat the deterministic CPM spine.
        if r.data.get("cpm_finish"):
            assert date.fromisoformat(r.data["p50"]) >= date.fromisoformat(r.data["cpm_finish"])


@pytest.mark.django_db
class TestMonteCarloProgressAware:
    """The forecast accounts for what is open vs. closed (ADR-0132): completed
    work is pinned to its actuals instead of being re-simulated from scratch."""

    def test_completed_phase_is_pinned_to_actuals(
        self,
        member_client: APIClient,
        project: Project,
    ) -> None:
        from trueppm_api.apps.projects.models import Dependency, Task, TaskStatus

        # Anchor the project and pick an explicit data date so the assertion is
        # deterministic (not dependent on the wall clock).
        project.start_date = date(2026, 3, 2)  # Monday
        project.status_date = date(2026, 3, 23)  # Monday
        project.save(update_fields=["start_date", "status_date"])

        # A is a 5-day task that *actually* ran long, finishing 20-Mar (not the
        # 6-Mar its plan implies). B is a 3-day not-started successor.
        a = Task.objects.create(
            project=project,
            name="A",
            duration=5,
            status=TaskStatus.COMPLETE,
            actual_start=date(2026, 3, 2),
            actual_finish=date(2026, 3, 20),  # Friday
        )
        b = Task.objects.create(project=project, name="B", duration=3)
        Dependency.objects.create(predecessor=a, successor=b)

        r = member_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 100},
            format="json",
        )
        assert r.status_code == 200
        # B starts the working day after A's ACTUAL finish (Mon 23-Mar) and takes
        # 3 days → Wed 25-Mar. Were completion ignored (the old behavior), B would
        # be re-rolled from the planned schedule and finish far earlier.
        assert r.data["p50"] == r.data["p80"] == r.data["p95"] == "2026-03-25"
