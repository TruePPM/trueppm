"""Tests for GET /api/v1/projects/<pk>/schedule/feasibility/ (#5106)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(
        name="Loop", start_date=date(2026, 3, 2), status_date=date(2026, 3, 2), calendar=cal
    )


@pytest.fixture
def tasks(project: Project) -> dict[str, Task]:
    """A→B→C finish-to-start plus an unrelated D."""
    out = {n: Task.objects.create(project=project, name=f"Task {n}", duration=2) for n in "ABCD"}
    for p, s in ("AB", "BC"):
        Dependency.objects.create(predecessor=out[p], successor=out[s], dep_type="FS", lag=0)
    return out


def _client(project: Project, role: str | None) -> APIClient:
    user = User.objects.create_user(username=f"feas_{role}", password="pw")
    if role is not None:
        ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def url(pk: object) -> str:
    return f"/api/v1/projects/{pk}/schedule/feasibility/"


@pytest.mark.django_db
def test_acyclic_network_is_computable(project: Project, tasks: dict[str, Task]) -> None:
    resp = _client(project, Role.VIEWER).get(url(project.pk))
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["computable"] is True
    assert body["code"] is None
    assert body["cycle"] == []
    assert body["tasks"] == []
    assert body["definition"] is None
    assert body["as_of"]


@pytest.mark.django_db
def test_loop_names_every_task_in_it_once(project: Project, tasks: dict[str, Task]) -> None:
    # The interactive serializer refuses this edge; an ORM write stands in for an
    # import or legacy write that left the loop behind.
    Dependency.objects.create(predecessor=tasks["C"], successor=tasks["A"], dep_type="FS", lag=0)
    resp = _client(project, Role.VIEWER).get(url(project.pk))
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["computable"] is False
    assert body["code"] == "cyclic_dependency"
    names = [row["name"] for row in body["cycle"]]
    assert sorted(names) == ["Task A", "Task B", "Task C"]
    assert len(names) == len(set(names)), "find_cycle's repeated head must be dropped"
    assert {row["id"] for row in body["cycle"]} == {str(tasks[n].pk) for n in "ABC"}
    assert "loop" in body["definition"]
    # Same verdict as the engine's own schedule() refusal.
    from trueppm_scheduler import CyclicDependencyError, schedule

    from trueppm_api.apps.scheduling.views import _build_cpm_sched_project

    with pytest.raises(CyclicDependencyError):
        schedule(_build_cpm_sched_project(project, str(project.pk)))


@pytest.mark.django_db
def test_soft_deleted_link_does_not_close_a_loop(project: Project, tasks: dict[str, Task]) -> None:
    dep = Dependency.objects.create(
        predecessor=tasks["C"], successor=tasks["A"], dep_type="FS", lag=0
    )
    if not hasattr(dep, "is_deleted"):
        pytest.skip("Dependency has no soft delete")
    Dependency.objects.filter(pk=dep.pk).update(is_deleted=True)
    body = _client(project, Role.VIEWER).get(url(project.pk)).json()
    assert body["computable"] is True


@pytest.mark.django_db
def test_non_member_is_refused(project: Project, tasks: dict[str, Task]) -> None:
    resp = _client(project, None).get(url(project.pk))
    assert resp.status_code == 403


@pytest.mark.django_db
def test_anonymous_is_refused(project: Project) -> None:
    assert APIClient().get(url(project.pk)).status_code in (401, 403)


@pytest.mark.django_db
def test_unknown_and_trashed_project_404(project: Project) -> None:
    c = _client(project, Role.OWNER)
    import uuid

    assert c.get(url(uuid.uuid4())).status_code == 404
    Project.objects.filter(pk=project.pk).update(is_deleted=True)
    assert c.get(url(project.pk)).status_code == 404


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN, Role.OWNER])
def test_every_member_role_reads_it(project: Project, role: str) -> None:
    assert _client(project, role).get(url(project.pk)).status_code == 200
