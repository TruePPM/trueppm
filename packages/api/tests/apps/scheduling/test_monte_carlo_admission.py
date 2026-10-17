"""Monte Carlo request-path admission: the runs x tasks cell cap and slot pool (#2839).

The per-dimension caps (MC_SIMULATION_CAP, MC_TASK_CAP) let ``runs x n_tasks`` reach
5M cells, ~234 MB traced per simulation. ``MC_CELL_CAP`` caps the product and
``MC_MAX_CONCURRENT`` the simulations one process runs at once. Caps are patched
small here — no test builds a real 5,000-task project.
"""

from __future__ import annotations

import threading
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling import mc_admission
from trueppm_api.apps.scheduling.mc_admission import admit_runs, max_runs_for

User = get_user_model()


@pytest.fixture(autouse=True)
def _clear_cache() -> object:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Admission", start_date=date(2026, 1, 5), calendar=cal)


@pytest.fixture
def tasks(project: Project) -> list[Task]:
    return [
        Task.objects.create(
            project=project,
            name=f"T{i}",
            duration=5,
            optimistic_duration=3,
            most_likely_duration=5,
            pessimistic_duration=10,
        )
        for i in range(4)
    ]


@pytest.fixture
def client(project: Project) -> APIClient:
    user = User.objects.create_user(username="adm_user", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _run_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/monte-carlo/"


def _whatif_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/monte-carlo/whatif/"


# ---------------------------------------------------------------------------
# Unit: admit_runs
# ---------------------------------------------------------------------------


class TestAdmitRuns:
    def test_max_runs_is_product_bound(self, settings: object) -> None:
        settings.MC_SIMULATION_CAP = 1_000  # type: ignore[attr-defined]
        settings.MC_CELL_CAP = 2_500_000  # type: ignore[attr-defined]
        assert max_runs_for(5_000) == 500
        assert max_runs_for(2_500) == 1_000
        assert max_runs_for(100) == 1_000

    def test_omitted_runs_scale_down_to_fit(self, settings: object) -> None:
        settings.MC_SIMULATION_CAP = 1_000  # type: ignore[attr-defined]
        settings.MC_TASK_CAP = 5_000  # type: ignore[attr-defined]
        settings.MC_CELL_CAP = 2_500_000  # type: ignore[attr-defined]
        adm = admit_runs(5_000, None)
        assert adm.refusal is None
        assert adm.runs == 500
        # The 120 MB shape from the issue: never admitted at full size.
        assert adm.runs * 5_000 <= 2_500_000

    def test_explicit_runs_over_product_are_refused_not_shrunk(self, settings: object) -> None:
        settings.MC_SIMULATION_CAP = 1_000  # type: ignore[attr-defined]
        settings.MC_TASK_CAP = 5_000  # type: ignore[attr-defined]
        settings.MC_CELL_CAP = 2_500_000  # type: ignore[attr-defined]
        adm = admit_runs(5_000, 1_000)
        assert adm.refusal is not None
        assert adm.refusal.status_code == 400
        assert adm.refusal.data["error"] == "simulation_cell_cap_exceeded"
        assert adm.refusal.data["max_runs"] == 500
        assert adm.refusal.data["task_count"] == 5_000

    def test_explicit_runs_within_product_are_honored(self, settings: object) -> None:
        settings.MC_CELL_CAP = 2_500_000  # type: ignore[attr-defined]
        assert admit_runs(5_000, 500).runs == 500

    def test_per_dimension_caps_keep_their_402_path(self, settings: object) -> None:
        """Over MC_SIMULATION_CAP or MC_TASK_CAP passes through to the engine's 402."""
        settings.MC_SIMULATION_CAP = 100  # type: ignore[attr-defined]
        settings.MC_TASK_CAP = 10  # type: ignore[attr-defined]
        settings.MC_CELL_CAP = 50  # type: ignore[attr-defined]
        assert admit_runs(5, 101).refusal is None  # sim cap: engine refuses
        assert admit_runs(11, 10).refusal is None  # task cap: engine refuses

    def test_cell_cap_none_is_unbounded(self, settings: object) -> None:
        settings.MC_SIMULATION_CAP = None  # type: ignore[attr-defined]
        settings.MC_CELL_CAP = None  # type: ignore[attr-defined]
        assert admit_runs(5_000, 2_000).runs == 2_000

    def test_shipped_default_bounds_the_measured_shape(self) -> None:
        """At the shipped caps the product is at most half the measured 5M-cell call."""
        from django.conf import settings as dj

        assert dj.MC_CELL_CAP is not None
        assert dj.MC_CELL_CAP <= 5_000_000 // 2
        assert dj.MC_TASK_CAP is not None
        # A project at the task cap still gets a usable sample.
        assert dj.MC_CELL_CAP // dj.MC_TASK_CAP >= 200
        assert dj.MC_MAX_CONCURRENT is not None


# ---------------------------------------------------------------------------
# Integration: run_monte_carlo and what-if
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRunEndpointAdmission:
    def test_omitted_n_simulations_reports_effective_runs(
        self, client: APIClient, project: Project, tasks: list[Task], settings: object
    ) -> None:
        settings.MC_SIMULATION_CAP = 100  # type: ignore[attr-defined]
        settings.MC_CELL_CAP = 4 * 30  # type: ignore[attr-defined]  # 4 leaf tasks -> 30 runs
        r = client.post(_run_url(project), format="json")
        assert r.status_code == 200, r.data
        assert r.data["runs"] == 30

    def test_explicit_n_simulations_over_product_is_400(
        self, client: APIClient, project: Project, tasks: list[Task], settings: object
    ) -> None:
        settings.MC_SIMULATION_CAP = 100  # type: ignore[attr-defined]
        settings.MC_CELL_CAP = 4 * 30  # type: ignore[attr-defined]
        r = client.post(_run_url(project), {"n_simulations": 31}, format="json")
        assert r.status_code == 400
        assert r.data["error"] == "simulation_cell_cap_exceeded"
        assert r.data["max_runs"] == 30

    def test_busy_process_returns_503(
        self,
        client: APIClient,
        project: Project,
        tasks: list[Task],
        settings: object,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Every slot held elsewhere -> 503 + Retry-After, without simulating."""
        settings.MC_MAX_CONCURRENT = 1  # type: ignore[attr-defined]
        monkeypatch.setattr(mc_admission, "MC_SLOT_WAIT_SECONDS", 0.01)
        sem = mc_admission._semaphore()
        assert sem is not None
        assert sem.acquire(blocking=False)
        try:
            r = client.post(_run_url(project), {"n_simulations": 10}, format="json")
        finally:
            sem.release()
        assert r.status_code == 503
        assert r.data["error"] == "simulation_busy"
        assert r.headers["Retry-After"] == str(mc_admission.MC_BUSY_RETRY_AFTER_SECONDS)
        # The slot is free again: the next run is admitted.
        r2 = client.post(_run_url(project), {"n_simulations": 10}, format="json")
        assert r2.status_code == 200


@pytest.mark.django_db
class TestWhatIfAdmission:
    def test_omitted_n_simulations_reports_effective_runs(
        self, client: APIClient, project: Project, tasks: list[Task], settings: object
    ) -> None:
        settings.MC_SIMULATION_CAP = 100  # type: ignore[attr-defined]
        settings.MC_CELL_CAP = 4 * 25  # type: ignore[attr-defined]
        r = client.get(_whatif_url(project), {"task_id": str(tasks[0].pk), "duration_delta": 2})
        assert r.status_code == 200, r.data
        assert r.data["runs"] == 25

    def test_explicit_n_simulations_over_product_is_400(
        self, client: APIClient, project: Project, tasks: list[Task], settings: object
    ) -> None:
        settings.MC_SIMULATION_CAP = 100  # type: ignore[attr-defined]
        settings.MC_CELL_CAP = 4 * 25  # type: ignore[attr-defined]
        r = client.get(
            _whatif_url(project),
            {"task_id": str(tasks[0].pk), "duration_delta": 2, "n_simulations": 26},
        )
        assert r.status_code == 400
        assert r.data["error"] == "simulation_cell_cap_exceeded"
        assert r.data["max_runs"] == 25

    def test_busy_process_returns_503(
        self,
        client: APIClient,
        project: Project,
        tasks: list[Task],
        settings: object,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        settings.MC_MAX_CONCURRENT = 1  # type: ignore[attr-defined]
        monkeypatch.setattr(mc_admission, "MC_SLOT_WAIT_SECONDS", 0.01)
        sem = mc_admission._semaphore()
        assert sem is not None
        assert sem.acquire(blocking=False)
        try:
            r = client.get(
                _whatif_url(project),
                {"task_id": str(tasks[0].pk), "duration_delta": 2, "n_simulations": 10},
            )
        finally:
            sem.release()
        assert r.status_code == 503
        assert r.data["error"] == "simulation_busy"


# ---------------------------------------------------------------------------
# Unit: the slot pool
# ---------------------------------------------------------------------------


class TestSimulationSlot:
    def test_slot_bounds_concurrency_and_releases(
        self, settings: object, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        settings.MC_MAX_CONCURRENT = 2  # type: ignore[attr-defined]
        monkeypatch.setattr(mc_admission, "MC_SLOT_WAIT_SECONDS", 0.01)
        held = threading.Event()
        release = threading.Event()

        def hold() -> None:
            with mc_admission.simulation_slot() as ok:
                assert ok
                held.set()
                release.wait(5)

        workers = [threading.Thread(target=hold) for _ in range(2)]
        for w in workers:
            held.clear()
            w.start()
            assert held.wait(5)
        try:
            with mc_admission.simulation_slot() as ok:
                assert ok is False  # both slots held
        finally:
            release.set()
            for w in workers:
                w.join(5)
        with mc_admission.simulation_slot() as ok:
            assert ok is True

    def test_none_disables_the_pool(self, settings: object) -> None:
        settings.MC_MAX_CONCURRENT = None  # type: ignore[attr-defined]
        with mc_admission.simulation_slot() as ok:
            assert ok is True
