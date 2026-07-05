"""Tests for GET /api/v1/projects/<pk>/schedule/derivation/ (ADR-0218, #1058)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task

User = get_user_model()


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="deriv_user", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="deriv_other", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    # Monday start so weekday arithmetic is predictable.
    return Project.objects.create(
        name="Derivation Project", start_date=date(2026, 3, 2), calendar=calendar
    )


@pytest.fixture
def chain(project: Project) -> dict[str, Task]:
    """A→B finish-to-start chain so B's start is driven by A."""
    a = Task.objects.create(project=project, name="Design", duration=3)
    b = Task.objects.create(project=project, name="Build", duration=2)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS", lag=0)
    return {"A": a, "B": b}


@pytest.fixture
def member_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/schedule/derivation/"


@pytest.mark.django_db
class TestScheduleDerivationAuth:
    def test_unauthenticated_returns_401(self, project: Project) -> None:
        res = APIClient().get(url(project.pk), {"task_id": "x", "quantity": "early_start"})
        assert res.status_code == 401

    def test_non_member_returns_403(self, other_user: object, project: Project) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.get(url(project.pk), {"task_id": "x", "quantity": "early_start"})
        assert res.status_code == 403

    def test_unknown_project_returns_404(self, member_client: APIClient) -> None:
        res = member_client.get(
            url("00000000-0000-0000-0000-000000000000"),
            {"task_id": "x", "quantity": "early_start"},
        )
        assert res.status_code == 404


@pytest.mark.django_db
class TestScheduleDerivationCpm:
    def test_early_start_names_driving_predecessor(
        self, member_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        res = member_client.get(
            url(project.pk),
            {"task_id": str(chain["B"].id), "quantity": "early_start"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["quantity"] == "early_start"
        assert data["pass"] == "forward"
        assert data["binding"] is not None
        assert data["binding"]["kind"] == "predecessor_fs"
        assert data["binding"]["source_task_id"] == str(chain["A"].id)
        assert data["binding"]["source_task_name"] == "Design"
        assert data["binding"]["dep_type"] == "FS"
        # Every candidate the engine weighed is present, binding flagged.
        assert any(c["is_binding"] for c in data["contributions"])

    def test_root_task_bound_by_anchor(
        self, member_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        # The API sets the data date to today when the project has no status date
        # (ADR-0132), so a root task is floored by the data date (or project start
        # when the project starts in the future) — an anchor, not a predecessor.
        res = member_client.get(
            url(project.pk),
            {"task_id": str(chain["A"].id), "quantity": "early_start"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["binding"]["kind"] in {"project_start", "data_date"}
        assert data["binding"]["source_task_id"] is None
        assert data["value"]  # a non-empty ISO date string

    def test_total_float_returns_working_days(
        self, member_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        res = member_client.get(
            url(project.pk),
            {"task_id": str(chain["A"].id), "quantity": "total_float"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["pass"] == "float"
        assert isinstance(data["value"], int)

    def test_missing_quantity_returns_400(
        self, member_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        res = member_client.get(url(project.pk), {"task_id": str(chain["A"].id)})
        assert res.status_code == 400

    def test_unknown_quantity_returns_400(
        self, member_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        res = member_client.get(
            url(project.pk),
            {"task_id": str(chain["A"].id), "quantity": "bogus"},
        )
        assert res.status_code == 400

    def test_missing_task_id_returns_400(
        self, member_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        res = member_client.get(url(project.pk), {"quantity": "early_start"})
        assert res.status_code == 400

    def test_unknown_task_returns_404(
        self, member_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        res = member_client.get(
            url(project.pk),
            {"task_id": "00000000-0000-0000-0000-000000000000", "quantity": "early_start"},
        )
        assert res.status_code == 404

    def test_no_committed_tasks_returns_404(
        self, member_client: APIClient, project: Project
    ) -> None:
        res = member_client.get(
            url(project.pk),
            {"task_id": "00000000-0000-0000-0000-000000000000", "quantity": "early_start"},
        )
        assert res.status_code == 404


@pytest.mark.django_db
class TestScheduleDerivationMonteCarlo:
    def mc_url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/monte-carlo/"

    def test_percentile_without_run_returns_404(
        self, member_client: APIClient, project: Project, chain: dict[str, Task]
    ) -> None:
        res = member_client.get(url(project.pk), {"quantity": "p80"})
        assert res.status_code == 404

    def test_percentile_after_run_returns_derivation(
        self, member_client: APIClient, project: Project
    ) -> None:
        # A PERT task gives Monte Carlo a real band to derive against.
        Task.objects.create(
            project=project,
            name="Estimate",
            duration=5,
            optimistic_duration=3,
            most_likely_duration=5,
            pessimistic_duration=10,
        )
        run = member_client.post(self.mc_url(project.pk), {"n_simulations": 100}, format="json")
        assert run.status_code == 200

        res = member_client.get(url(project.pk), {"quantity": "p80"})
        assert res.status_code == 200
        data = res.json()
        assert data["quantity"] == "p80"
        assert data["pass"] == "monte_carlo"
        assert "cpm_finish" in data
        assert "delta_vs_cpm_days" in data
        assert "drivers" in data
