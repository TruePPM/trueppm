"""Query-shape tests for the schedule input build (#1501, #1541)."""

from __future__ import annotations

import re
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.tasks import _run_schedule
from trueppm_api.apps.scheduling.views import _build_sched_deps

User = get_user_model()


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Q", start_date=date(2026, 3, 2), calendar=cal)


@pytest.fixture
def chain(project: Project) -> dict[str, Task]:
    a = Task.objects.create(project=project, name="A", duration=3)
    b = Task.objects.create(project=project, name="B", duration=2)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS", lag=0)
    return {"A": a, "B": b}


@pytest.fixture
def client(project: Project) -> APIClient:
    user = User.objects.create_user(username="q_user", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _selects(ctx: CaptureQueriesContext) -> list[str]:
    return [q["sql"] for q in ctx.captured_queries if q["sql"].lstrip().startswith("SELECT")]


def _from_clause(sql: str) -> str:
    """Everything between the first top-level FROM and the WHERE (FROM + JOINs)."""
    after = sql.split(" FROM ", 1)[1]
    return re.split(r" WHERE | ORDER BY | LIMIT ", after, maxsplit=1)[0]


def _task_loads(selects: list[str]) -> list[str]:
    return [s for s in selects if _from_clause(s).lstrip().startswith('"projects_task"')]


def _dependency_loads(selects: list[str]) -> list[str]:
    return [s for s in selects if _from_clause(s).lstrip().startswith('"projects_dependency"')]


def _assert_dependency_load_joins_no_task_columns(selects: list[str]) -> None:
    loads = _dependency_loads(selects)
    assert loads, "no dependency load captured"
    for sql in loads:
        # SELECT list on purpose: ``predecessor__project_id`` legitimately JOINs
        # projects_task in the FROM clause, so a FROM-clause check would be wrong.
        select_list = sql.split(" FROM ", 1)[0]
        assert "projects_task" not in select_list


@pytest.mark.django_db
def test_build_sched_deps_selects_no_task_columns(chain: dict[str, Task], project: Project) -> None:
    ids = {str(t.pk) for t in chain.values()}
    with CaptureQueriesContext(connection) as ctx:
        deps = _build_sched_deps(str(project.pk), ids)
    assert len(deps) == 1
    _assert_dependency_load_joins_no_task_columns(_selects(ctx))


@pytest.mark.django_db
def test_run_schedule_does_not_prefetch_predecessors_or_join_task_per_edge(
    chain: dict[str, Task], project: Project
) -> None:
    with CaptureQueriesContext(connection) as ctx:
        _run_schedule(str(project.pk))
    selects = _selects(ctx)
    _assert_dependency_load_joins_no_task_columns(selects)
    dep_loads = _dependency_loads(selects)
    assert len(dep_loads) == 1, "dependencies must be loaded exactly once"
    assert 'successor_id" IN (' not in dep_loads[0], "tasks__predecessors prefetch is back"
    chain["B"].refresh_from_db()
    assert chain["B"].early_start is not None


def _assert_single_task_load(ctx: CaptureQueriesContext) -> None:
    loads = _task_loads(_selects(ctx))
    prefetches = [s for s in loads if re.search(r'"project_id" IN \(', s)]
    assert not prefetches, "project.tasks prefetch is back"


@pytest.mark.django_db
def test_monte_carlo_view_does_not_prefetch_project_tasks(
    client: APIClient, project: Project, chain: dict[str, Task]
) -> None:
    with CaptureQueriesContext(connection) as ctx:
        r = client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/", {"n_simulations": 50}, format="json"
        )
    assert r.status_code == 200
    _assert_single_task_load(ctx)
    assert len(_task_loads(_selects(ctx))) >= 1


@pytest.mark.django_db
def test_whatif_view_does_not_prefetch_project_tasks(
    client: APIClient, project: Project, chain: dict[str, Task]
) -> None:
    with CaptureQueriesContext(connection) as ctx:
        r = client.get(
            f"/api/v1/projects/{project.pk}/monte-carlo/whatif/",
            {"task_id": str(chain["A"].pk), "duration_delta": 1},
        )
    assert r.status_code == 200, r.content
    _assert_single_task_load(ctx)


@pytest.mark.django_db
def test_derivation_view_does_not_prefetch_project_tasks(
    client: APIClient, project: Project, chain: dict[str, Task]
) -> None:
    with CaptureQueriesContext(connection) as ctx:
        r = client.get(
            f"/api/v1/projects/{project.pk}/schedule/derivation/",
            {"task_id": str(chain["B"].pk), "quantity": "early_start"},
        )
    assert r.status_code == 200, r.content
    _assert_single_task_load(ctx)
    _assert_dependency_load_joins_no_task_columns(_selects(ctx))


@pytest.mark.django_db
def test_program_graph_dependencies_select_only_project_id_from_task(
    project: Project, chain: dict[str, Task]
) -> None:
    from trueppm_api.apps.projects.models import Program
    from trueppm_api.apps.projects.program_schedule import gather_program_schedule

    program = Program.objects.create(name="InputQueriesProgram")
    project.program = program
    project.save()

    with CaptureQueriesContext(connection) as ctx:
        graph = gather_program_schedule(program)
    loads = _dependency_loads(_selects(ctx))
    assert len(loads) == 1
    select_list = loads[0].split(" FROM ", 1)[0]
    task_cols = set(re.findall(r'"projects_task"\."(\w+)"', select_list))
    # Django always adds the related model's pk to a select_related + only() join.
    assert task_cols == {"id", "project_id"}, task_cols

    assert len(graph.db_deps) == 1
    with CaptureQueriesContext(connection) as after:
        for d in graph.db_deps:
            assert d.predecessor.project_id == d.successor.project_id
            assert d.dep_type == "FS"
            assert d.lag == 0
            assert d.pk is not None
    assert len(after) == 0
