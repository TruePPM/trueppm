"""Schedule-fetch pagination for TaskViewSet + DependencyViewSet (issue 1519).

The Gantt initial load walked ``ceil(N / 50)`` pages of the global default
serially. ScheduleFetchPagination exposes a client-tunable ``page_size`` (bounded
at ``max_page_size=500``) so the client can request a large first page and fetch
the remainder in parallel. These tests assert the override honors ``page_size``,
clamps it at the ceiling, and falls back to the global default (50) when unset.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.request import Request
from rest_framework.test import APIClient, APIRequestFactory

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.projects.views import ScheduleFetchPagination

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Std")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def many_tasks(project: Project) -> list[Task]:
    """61 tasks — enough to exceed the global default page (50) but stay small."""
    return [Task.objects.create(project=project, name=f"T{i}", duration=1) for i in range(61)]


@pytest.fixture
def many_dependencies(many_tasks: list[Task]) -> list[Dependency]:
    """60 FS chain edges (t[i] -> t[i+1]) — also exceeds the default page."""
    return [
        Dependency.objects.create(
            predecessor=many_tasks[i], successor=many_tasks[i + 1], dep_type="FS"
        )
        for i in range(len(many_tasks) - 1)
    ]


# ---------------------------------------------------------------------------
# Pagination class unit tests (clamp / honor / default without a huge dataset)
# ---------------------------------------------------------------------------


def test_pagination_honors_page_size() -> None:
    paginator = ScheduleFetchPagination()
    req = Request(APIRequestFactory().get("/api/v1/tasks/", {"page_size": "200"}))
    assert paginator.get_page_size(req) == 200


def test_pagination_clamps_at_max_page_size() -> None:
    paginator = ScheduleFetchPagination()
    req = Request(APIRequestFactory().get("/api/v1/tasks/", {"page_size": "99999"}))
    assert paginator.get_page_size(req) == 500
    assert paginator.max_page_size == 500


def test_pagination_defaults_to_global_page_size_when_unset() -> None:
    paginator = ScheduleFetchPagination()
    req = Request(APIRequestFactory().get("/api/v1/tasks/"))
    assert paginator.get_page_size(req) == 50


# ---------------------------------------------------------------------------
# TaskViewSet integration
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_defaults_to_50(
    client: APIClient, project: Project, many_tasks: list[Task]
) -> None:
    resp = client.get("/api/v1/tasks/", {"project": str(project.pk)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 61
    assert len(body["results"]) == 50
    assert body["next"] is not None


@pytest.mark.django_db
def test_task_list_honors_page_size_200(
    client: APIClient, project: Project, many_tasks: list[Task]
) -> None:
    resp = client.get("/api/v1/tasks/", {"project": str(project.pk), "page_size": 200})
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 61
    assert len(body["results"]) == 61
    assert body["next"] is None


@pytest.mark.django_db
def test_task_list_page_size_clamped_at_500(
    client: APIClient, project: Project, many_tasks: list[Task]
) -> None:
    # With only 61 tasks the clamp cannot truncate; assert it does not error and
    # still returns every task in one page (the class-level clamp is covered above).
    resp = client.get("/api/v1/tasks/", {"project": str(project.pk), "page_size": 99999})
    assert resp.status_code == 200
    assert len(resp.json()["results"]) == 61


# ---------------------------------------------------------------------------
# DependencyViewSet integration
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_dependency_list_defaults_to_50(
    client: APIClient, project: Project, many_dependencies: list[Dependency]
) -> None:
    resp = client.get("/api/v1/dependencies/", {"project": str(project.pk)})
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 60
    assert len(body["results"]) == 50
    assert body["next"] is not None


@pytest.mark.django_db
def test_dependency_list_honors_page_size_200(
    client: APIClient, project: Project, many_dependencies: list[Dependency]
) -> None:
    resp = client.get("/api/v1/dependencies/", {"project": str(project.pk), "page_size": 200})
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 60
    assert len(body["results"]) == 60
    assert body["next"] is None
