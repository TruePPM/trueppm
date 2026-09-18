"""Tests for the ``?id__in=`` filter on ``GET /api/v1/tasks/`` (#3843).

Batch name-resolution for an ID-only payload: a client that already holds a
list of task UUIDs (e.g. ``UtilizationDayEntry.tasks`` from the resource
utilization endpoint) fetches their rows in one request instead of one GET
per id. Mirrors the ``?labels=`` filter's tests (test_labels.py, #2331) in
shape: exact-match set assertions, a clean 400 on a malformed UUID, and an
IDOR check that a foreign task id is silently omitted rather than erroring.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def member_client(member_user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def memberships(project: Project, member_user: object) -> None:
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)


@pytest.fixture
def scenario(project: Project, memberships: None) -> dict[str, Any]:
    t_a = Task.objects.create(project=project, name="A task", duration=1)
    t_b = Task.objects.create(project=project, name="B task", duration=1)
    t_c = Task.objects.create(project=project, name="C task", duration=1)
    return {"t_a": t_a, "t_b": t_b, "t_c": t_c}


@pytest.mark.django_db
class TestTaskIdInFilter:
    @staticmethod
    def _ids(res: Any) -> set[str]:
        return {str(row["id"]) for row in res.data["results"]}

    def test_single_id_returns_only_that_task(
        self, member_client: APIClient, project: Project, scenario: dict[str, Any]
    ) -> None:
        res = member_client.get(f"/api/v1/tasks/?project={project.pk}&id__in={scenario['t_a'].pk}")
        assert res.status_code == 200, res.data
        assert self._ids(res) == {str(scenario["t_a"].pk)}

    def test_multiple_ids_are_deduplicated_and_exact(
        self, member_client: APIClient, project: Project, scenario: dict[str, Any]
    ) -> None:
        res = member_client.get(
            f"/api/v1/tasks/?project={project.pk}"
            f"&id__in={scenario['t_a'].pk},{scenario['t_b'].pk},{scenario['t_a'].pk}"
        )
        assert res.status_code == 200, res.data
        assert self._ids(res) == {str(scenario["t_a"].pk), str(scenario["t_b"].pk)}
        assert str(scenario["t_c"].pk) not in self._ids(res)

    def test_nonexistent_id_resolves_to_empty_not_error(
        self, member_client: APIClient, project: Project, scenario: dict[str, Any]
    ) -> None:
        # A random UUID that no Task carries — a stale/deleted contributing-task
        # id from a drawer payload must resolve to an empty result, not a 404/500.
        import uuid as uuid_mod

        res = member_client.get(f"/api/v1/tasks/?project={project.pk}&id__in={uuid_mod.uuid4()}")
        assert res.status_code == 200, res.data
        assert self._ids(res) == set()

    def test_malformed_uuid_returns_400(
        self, member_client: APIClient, project: Project, memberships: None
    ) -> None:
        res = member_client.get(f"/api/v1/tasks/?project={project.pk}&id__in=not-a-uuid")
        assert res.status_code == 400, res.data
        assert "id__in" in res.data

    def test_no_id__in_param_returns_all_tasks(
        self, member_client: APIClient, project: Project, scenario: dict[str, Any]
    ) -> None:
        res = member_client.get(f"/api/v1/tasks/?project={project.pk}")
        assert res.status_code == 200
        assert self._ids(res) >= {
            str(scenario["t_a"].pk),
            str(scenario["t_b"].pk),
            str(scenario["t_c"].pk),
        }

    def test_foreign_task_id_leaks_nothing(
        self,
        member_client: APIClient,
        project: Project,
        calendar: Calendar,
        scenario: dict[str, Any],
    ) -> None:
        # A task on a DIFFERENT project the member is not part of. Filtering by
        # its id returns nothing — no cross-project leak, and no error either
        # (ProjectScopedViewSet.get_queryset already excludes it before this
        # filter runs, so id__in has nothing to match against).
        other = Project.objects.create(name="Other", start_date=date(2026, 4, 1), calendar=calendar)
        foreign_task = Task.objects.create(project=other, name="Hidden", duration=1)
        res = member_client.get(f"/api/v1/tasks/?id__in={foreign_task.pk}")
        assert res.status_code == 200, res.data
        assert str(foreign_task.pk) not in self._ids(res)
