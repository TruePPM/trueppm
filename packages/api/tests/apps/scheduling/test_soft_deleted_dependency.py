"""A soft-deleted dependency must stop constraining every scheduling surface (#3532).

``DependencyViewSet.perform_destroy`` soft-deletes the edge and enqueues a
recalculation. Three of the four scheduler-input builders queried
``Dependency.objects`` with no ``is_deleted`` filter, so the deleted edge kept
binding: the persisted CPM dates, the Monte Carlo forecast, the what-if forecast,
and — worst — the derivation endpoint, which then explained a constraint the user
had already removed.

Every case below is pinned to the same two-task chain so the magnitude is the one
measured on the issue: A(5d) then B(2d) finishes Tue 10-Mar; with the edge gone
B finishes Tue 3-Mar and the project finishes when A does, Fri 6-Mar.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.tasks import _run_schedule

User = get_user_model()

# Mon 2-Mar-2026. Pinned (not "today") so every date below is weekday arithmetic,
# not wall-clock arithmetic — the data-date floor resolves to the status date.
PROJECT_START = date(2026, 3, 2)
# A(5 working days) runs Mon 2-Mar .. Fri 6-Mar.
A_FINISH = date(2026, 3, 6)
# B(2 days) released by the FS link on Mon 9-Mar, finishing Tue 10-Mar.
B_FINISH_CONSTRAINED = date(2026, 3, 10)
# B(2 days) with no predecessor: Mon 2-Mar .. Tue 3-Mar. Seven calendar days earlier.
B_FINISH_FREE = date(2026, 3, 3)


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="SoftDeleteDepStd")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="SoftDeleteDepProj",
        start_date=PROJECT_START,
        # Explicit status date: a null one floors the network at today, which would
        # make every expectation here move with the wall clock.
        status_date=PROJECT_START,
        calendar=calendar,
    )


@pytest.fixture
def chain(project: Project) -> tuple[Task, Task, Dependency]:
    """A(5d) --FS--> B(2d), the network the whole module discriminates on."""
    a = Task.objects.create(project=project, name="Design", duration=5)
    b = Task.objects.create(project=project, name="Build", duration=2)
    edge = Dependency.objects.create(predecessor=a, successor=b, dep_type="FS", lag=0)
    return a, b, edge


@pytest.fixture
def member_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="softdel_member", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _recompute(project: Project) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))


# ---------------------------------------------------------------------------
# The manager itself — the class fix, asserted on the compiled WHERE clause.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestLiveDependencyManager:
    def test_live_manager_emits_an_is_deleted_predicate_in_the_where_clause(
        self, chain: tuple[Task, Task, Dependency], project: Project
    ) -> None:
        """Assert on the WHERE clause, not on ``'is_deleted' in str(query)``.

        ``is_deleted`` is a column on the table, so it appears in the SELECT list
        of *every* Dependency query — a substring probe on the whole SQL string
        reports a false pass against an unfiltered manager.
        """
        sql, _params = Dependency.live.filter(
            predecessor__project_id=project.pk
        ).query.sql_with_params()
        where = sql.split(" WHERE ", 1)[1]
        assert 'NOT "projects_dependency"."is_deleted"' in where, (
            f"live manager emitted no is_deleted predicate: {where}"
        )

        unfiltered_sql, _ = Dependency.objects.filter(
            predecessor__project_id=project.pk
        ).query.sql_with_params()
        unfiltered_where = unfiltered_sql.split(" WHERE ", 1)[1]
        assert '"is_deleted"' not in unfiltered_where, (
            "Dependency.objects must stay unfiltered — the sync delta pull, the "
            "tombstone reap and the restore paths all need to see deleted edges."
        )

    def test_live_manager_hides_a_soft_deleted_edge_from_reads(
        self, chain: tuple[Task, Task, Dependency]
    ) -> None:
        _a, _b, edge = chain
        assert Dependency.live.filter(pk=edge.pk).exists()

        edge.soft_delete()

        assert not Dependency.live.filter(pk=edge.pk).exists()
        # ...and the default manager still sees it, or the sync tombstone is lost.
        assert Dependency.objects.filter(pk=edge.pk).exists()


# ---------------------------------------------------------------------------
# Site 1 — deterministic CPM write-back (scheduling/tasks.py::_run_schedule)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDeterministicCpmWriteBack:
    def test_recompute_after_delete_moves_the_successor_earlier(
        self, project: Project, chain: tuple[Task, Task, Dependency]
    ) -> None:
        _a, b, edge = chain

        _recompute(project)
        b.refresh_from_db()
        assert b.early_finish == B_FINISH_CONSTRAINED, "baseline: the live edge must bind B"

        edge.soft_delete()
        _recompute(project)

        b.refresh_from_db()
        assert b.early_finish == B_FINISH_FREE, (
            "a deleted dependency still constrained the persisted CPM dates "
            f"({B_FINISH_CONSTRAINED} vs {B_FINISH_FREE} — seven calendar days)"
        )

    def test_deleted_edge_is_not_flagged_driving(
        self, project: Project, chain: tuple[Task, Task, Dependency]
    ) -> None:
        """A deleted edge is not in the network, so it cannot drive anything."""
        _a, _b, edge = chain
        _recompute(project)
        edge.refresh_from_db()
        assert edge.is_driving is True, "baseline: the live FS link drives B"

        # soft_delete() goes through save(), which rewrites every field — so the
        # flag has to be cleared AFTER the delete for this to measure the recompute.
        edge.soft_delete()
        Dependency.objects.filter(pk=edge.pk).update(is_driving=False)
        _recompute(project)

        edge.refresh_from_db()
        assert edge.is_driving is False


# ---------------------------------------------------------------------------
# Site 2 — Monte Carlo and what-if (scheduling/views.py::_build_sched_deps)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestMonteCarloInput:
    def test_build_sched_deps_drops_a_soft_deleted_edge(
        self, project: Project, chain: tuple[Task, Task, Dependency]
    ) -> None:
        """The shared builder behind both ``run_monte_carlo`` and the what-if view."""
        from trueppm_api.apps.scheduling.views import _build_sched_deps

        a, b, edge = chain
        included = {str(a.id), str(b.id)}
        assert len(_build_sched_deps(str(project.pk), included)) == 1

        edge.soft_delete()

        assert _build_sched_deps(str(project.pk), included) == []

    def test_monte_carlo_forecast_ignores_a_soft_deleted_edge(
        self, member_client: APIClient, project: Project, chain: tuple[Task, Task, Dependency]
    ) -> None:
        _a, _b, edge = chain
        url = f"/api/v1/projects/{project.pk}/monte-carlo/"

        res = member_client.post(url, {"n_simulations": 200}, format="json")
        assert res.status_code == 200
        assert res.json()["p95"] == B_FINISH_CONSTRAINED.isoformat()

        edge.soft_delete()
        cache.clear()

        res = member_client.post(url, {"n_simulations": 200}, format="json")
        assert res.status_code == 200
        assert res.json()["p95"] == A_FINISH.isoformat(), (
            "the forecast was still anchored on a dependency the user deleted"
        )


@pytest.mark.django_db
class TestMonteCarloWhatIf:
    def test_whatif_baseline_ignores_a_soft_deleted_edge(
        self, member_client: APIClient, project: Project, chain: tuple[Task, Task, Dependency]
    ) -> None:
        a, _b, edge = chain
        url = f"/api/v1/projects/{project.pk}/monte-carlo/whatif/"
        params = {"task_id": str(a.id), "duration_delta": 2, "n_simulations": 200}

        res = member_client.get(url, params)
        assert res.status_code == 200
        assert res.json()["current"]["cpm_finish"] == B_FINISH_CONSTRAINED.isoformat()

        edge.soft_delete()

        res = member_client.get(url, params)
        assert res.status_code == 200
        body = res.json()
        assert body["current"]["cpm_finish"] == A_FINISH.isoformat(), (
            "the what-if baseline was computed against a deleted constraint"
        )
        # And the perturbation now propagates through A alone rather than through
        # a link that no longer exists.
        assert body["whatif"]["cpm_finish"] == date(2026, 3, 10).isoformat()


# ---------------------------------------------------------------------------
# Site 3 — derivation / explainability (views.py::_build_cpm_sched_project)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestScheduleDerivation:
    def test_derivation_does_not_cite_a_deleted_predecessor(
        self, member_client: APIClient, project: Project, chain: tuple[Task, Task, Dependency]
    ) -> None:
        """The sharpest harm: the endpoint that answers *why* naming a dead edge."""
        a, b, edge = chain
        url = f"/api/v1/projects/{project.pk}/schedule/derivation/"
        params = {"task_id": str(b.id), "quantity": "early_start"}

        res = member_client.get(url, params)
        assert res.status_code == 200
        assert res.json()["binding"]["kind"] == "predecessor_fs", "baseline: A drives B"

        edge.soft_delete()

        res = member_client.get(url, params)
        assert res.status_code == 200
        data = res.json()
        assert data["binding"]["kind"] != "predecessor_fs", (
            "the derivation explained B's start with a dependency the user deleted"
        )
        assert data["binding"]["source_task_id"] is None
        assert not [c for c in data["contributions"] if c["kind"] == "predecessor_fs"], (
            "the deleted edge was still weighed as a candidate constraint"
        )
        assert str(a.id) not in str(data)


# ---------------------------------------------------------------------------
# Site 4 — the merged program pass, which was already correct. Pinned so the
# `Dependency.objects` -> `Dependency.live` rewrite cannot silently change it.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProgramSchedule:
    def test_program_gather_still_excludes_a_soft_deleted_edge(
        self, project: Project, chain: tuple[Task, Task, Dependency]
    ) -> None:
        from trueppm_api.apps.projects.models import Program
        from trueppm_api.apps.projects.program_schedule import gather_program_schedule

        _a, _b, edge = chain
        program = Program.objects.create(name="SoftDeleteDepProgram")
        project.program = program
        project.save()

        graph = gather_program_schedule(program)
        assert len(graph.db_deps) == 1

        edge.soft_delete()

        graph = gather_program_schedule(program)
        assert graph.db_deps == []
