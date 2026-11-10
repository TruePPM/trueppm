"""The two remaining date-blind overallocation reads are per-day now (#3544).

``assignee_is_overallocated`` (task list annotation) and the project attention
feed's overallocation bucket both compared a project-lifetime ``Sum(units)`` to a
capacity, so three non-overlapping tasks read as over capacity (the #3534 defect on
``_check_overallocation``). Each case pairs a no-overlap (silent) control with a
genuine overlap (flagged) at the same lifetime load.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std", working_days=31, hours_per_day=8.0)
    return Project.objects.create(name="Atlas", start_date=date(2026, 3, 2), calendar=cal)


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="u_3544", password="pw")


@pytest.fixture
def client(user: Any, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _task(project: Project, user: Any, name: str, start: date | None, end: date | None) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        assignee=user,
        status=TaskStatus.IN_PROGRESS,
        early_start=start,
        early_finish=end,
    )


def _load(project: Project, user: Any, spans: list[tuple[date | None, date | None]]) -> Resource:
    res = Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
    for i, (s, e) in enumerate(spans):
        TaskResource.objects.create(
            task=_task(project, user, f"T{i}", s, e), resource=res, units=Decimal("0.4")
        )
    return res


# Three 0.4-unit tasks: lifetime sum 1.2 > 1.0 in both layouts below.
SEQUENTIAL = [
    (date(2026, 3, 2), date(2026, 3, 3)),
    (date(2026, 3, 4), date(2026, 3, 5)),
    (date(2026, 3, 9), date(2026, 3, 10)),
]
OVERLAPPING = [
    (date(2026, 3, 2), date(2026, 3, 6)),
    (date(2026, 3, 3), date(2026, 3, 6)),
    (date(2026, 3, 4), date(2026, 3, 6)),
]


def _flags(client: APIClient, project: Project) -> list[bool]:
    resp = client.get(f"/api/v1/tasks/?project={project.pk}&page_size=50")
    assert resp.status_code == 200, resp.content
    rows = resp.data["results"] if isinstance(resp.data, dict) else resp.data
    return [r["assignee_is_overallocated"] for r in rows]


@pytest.mark.django_db
class TestTaskListAnnotation:
    def test_non_overlapping_tasks_are_not_flagged(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        _load(project, user, SEQUENTIAL)
        assert _flags(client, project) == [False, False, False]

    def test_genuinely_overlapping_tasks_are_flagged(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        _load(project, user, OVERLAPPING)
        assert all(_flags(client, project))

    def test_undated_tasks_count_on_every_day(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        _load(project, user, [(None, None)] * 3)
        assert all(_flags(client, project))

    def test_query_count_does_not_scale_with_rows(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        _load(project, user, OVERLAPPING)
        with CaptureQueriesContext(connection) as small:
            _flags(client, project)
        res = Resource.objects.get(user=user)
        for i in range(10):
            TaskResource.objects.create(
                task=_task(project, user, f"X{i}", date(2026, 3, 2), date(2026, 3, 6)),
                resource=res,
                units=Decimal("0.1"),
            )
        with CaptureQueriesContext(connection) as large:
            _flags(client, project)
        assert len(large) == len(small)


@pytest.mark.django_db
class TestAttentionFeed:
    def _items(self, client: APIClient, project: Project) -> list[dict[str, Any]]:
        resp = client.get(f"/api/v1/projects/{project.pk}/attention/")
        assert resp.status_code == 200, resp.content
        return [i for i in resp.data["items"] if i["type"] == "overallocation"]

    def test_non_overlapping_tasks_raise_no_item(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        _load(project, user, SEQUENTIAL)
        print([(t.early_start, t.early_finish, t.scheduled_start) for t in Task.objects.all()])
        assert self._items(client, project) == []

    def test_overlap_raises_one_item_with_the_peak_not_the_sum(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        _load(project, user, OVERLAPPING)
        items = self._items(client, project)
        assert [i["task_name"] for i in items] == ["Ada"]
        assert items[0]["detail"] == "Allocated 120% — over capacity"

    def test_peak_is_a_single_day_not_lifetime(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        # Two overlap on one day (0.8) with a third elsewhere: peak 0.8, sum 1.2.
        _load(
            project,
            user,
            [
                (date(2026, 3, 2), date(2026, 3, 3)),
                (date(2026, 3, 3), date(2026, 3, 4)),
                (date(2026, 3, 9), date(2026, 3, 10)),
            ],
        )
        assert self._items(client, project) == []
