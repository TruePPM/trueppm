"""Per-milestone percentiles (#4135) on the run endpoint.

The engine computes them (``monte_carlo(targets=...)``); the API only chooses the
targets and carries the result, so these pin the selection, the response shape and
what is persisted — never the math.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.models import MonteCarloRun
from trueppm_api.apps.scheduling.views import _mc_target_ids

User = get_user_model()


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="MC targets", start_date=date(2026, 1, 5), calendar=cal)


@pytest.fixture
def network(project: Project) -> dict[str, Task]:
    """A (PERT) -> M1 (milestone); B (fixed, longer) -> M2 (milestone)."""
    a = Task.objects.create(
        project=project,
        name="A",
        duration=5,
        optimistic_duration=5,
        most_likely_duration=6,
        pessimistic_duration=12,
    )
    b = Task.objects.create(project=project, name="B", duration=8)
    m1 = Task.objects.create(project=project, name="M1", duration=0, is_milestone=True)
    m2 = Task.objects.create(project=project, name="M2", duration=0, is_milestone=True)
    Dependency.objects.create(predecessor=a, successor=m1, dep_type="FS", lag=0)
    Dependency.objects.create(predecessor=b, successor=m2, dep_type="FS", lag=0)
    return {"A": a, "B": b, "M1": m1, "M2": m2}


@pytest.fixture
def admin_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="mc_targets_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
class TestRunCarriesTargets:
    def test_every_milestone_gets_percentiles_no_later_than_the_project(
        self, admin_client: APIClient, project: Project, network: dict[str, Task]
    ) -> None:
        res = admin_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/", {"n_simulations": 400}, format="json"
        )
        assert res.status_code == 200
        body = res.json()
        by_id = {t["task_id"]: t for t in body["targets"]}
        assert set(by_id) == {str(network["M1"].pk), str(network["M2"].pk)}
        for target in by_id.values():
            for q in ("p50", "p80", "p95"):
                assert target[q] <= body[q]
        # M2 hangs off fixed work, so it has no band at all.
        m2 = by_id[str(network["M2"].pk)]
        assert m2["p50"] == m2["p80"] == m2["p95"]

    def test_targets_persist_on_the_run_row(
        self, admin_client: APIClient, project: Project, network: dict[str, Task]
    ) -> None:
        admin_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/", {"n_simulations": 200}, format="json"
        )
        run = MonteCarloRun.objects.get(project=project)
        assert run.distribution is not None
        assert {t["task_id"] for t in run.distribution["targets"]} == {
            str(network["M1"].pk),
            str(network["M2"].pk),
        }

    def test_a_project_without_milestones_reports_an_empty_target_list(
        self, admin_client: APIClient, project: Project
    ) -> None:
        Task.objects.create(project=project, name="Solo", duration=3)
        body = admin_client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/", {"n_simulations": 50}, format="json"
        ).json()
        assert body["targets"] == []


@pytest.mark.django_db
def test_targets_survive_cache_expiry_via_the_history_fallback(
    admin_client: APIClient, project: Project
) -> None:
    persisted = {
        "task_id": "m1",
        "p50": "2026-02-03",
        "p80": "2026-02-05",
        "p95": "2026-02-09",
        "p50_at_day_start": False,
        "p80_at_day_start": False,
        "p95_at_day_start": True,
    }
    MonteCarloRun.objects.create(
        project=project,
        p80=date(2026, 2, 5),
        n_simulations=100,
        distribution={
            "histogram_buckets": [],
            "confidence_curve": [],
            "sensitivity": [],
            "targets": [persisted],
        },
    )
    cache.clear()  # simulate TTL expiry
    data = admin_client.get(f"/api/v1/projects/{project.pk}/monte-carlo/latest/").json()
    assert data["from_history"] is True
    assert data["targets"] == [persisted]


@pytest.mark.django_db
def test_target_selection_is_simulated_milestones_in_read_order_capped(project: Project) -> None:
    for i in range(4):
        Task.objects.create(project=project, name=f"M{i}", duration=0, is_milestone=True)
    Task.objects.create(project=project, name="W", duration=2)
    rows = list(Task.objects.filter(project=project))  # default ordering: WBS order
    milestones = [t for t in rows if t.is_milestone]

    class _Sched:
        def __init__(self, tid: str) -> None:
            self.id = tid

    # The first milestone is left out of the simulated network (e.g. a summary).
    sched = [_Sched(str(t.pk)) for t in rows if t.pk != milestones[0].pk]
    assert _mc_target_ids(rows, sched, cap=2) == [str(t.pk) for t in milestones[1:3]]
