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
        res = _load(project, user, OVERLAPPING)
        other = User.objects.create_user(username="u_3544_b", password="pw")
        ProjectMembership.objects.create(project=project, user=other, role=Role.MEMBER)
        res_b = Resource.objects.create(name="Bo", max_units=Decimal("1.0"), user=other)
        with CaptureQueriesContext(connection) as small:
            _flags(client, project)
        for i in range(10):
            owner, who = (user, res) if i % 2 == 0 else (other, res_b)
            TaskResource.objects.create(
                task=_task(project, owner, f"X{i}", date(2026, 3, 2), date(2026, 3, 6)),
                resource=who,
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


# Weekend-start case: A spans Sat-Mon, B and C sit on the weekend only. Site 1 anchors
# on the span's first CALENDAR day (Saturday, 1.2 covering) while the engine only
# counts working days (Monday, 0.4), so the task-list flag over-reports. The
# approximation is documented in annotate_tasks_queryset.
WEEKEND = [
    (date(2026, 3, 7), date(2026, 3, 9)),
    (date(2026, 3, 7), date(2026, 3, 8)),
    (date(2026, 3, 7), date(2026, 3, 8)),
]


@pytest.mark.django_db
class TestReadsAgree:
    """The invariant #3534 asks for, extended to the two reads #3544 fixed."""

    @pytest.mark.parametrize(
        ("spans", "over"),
        [
            pytest.param(SEQUENTIAL, False, id="sequential"),
            pytest.param(OVERLAPPING, True, id="overlapping"),
            pytest.param([(None, None)] * 3, True, id="undated"),
            pytest.param(
                WEEKEND,
                False,
                id="weekend-start",
                marks=pytest.mark.xfail(
                    strict=True,
                    reason="site 1 anchors on the span's first calendar day, not first "
                    "working day (documented approximation in annotate_tasks_queryset)",
                ),
            ),
        ],
    )
    def test_flag_feed_peak_and_write_warning_agree(
        self,
        client: APIClient,
        project: Project,
        user: Any,
        spans: list[tuple[date | None, date | None]],
        over: bool,
    ) -> None:
        from trueppm_api.apps.projects.utilization import Allocation, peak_concurrent_units
        from trueppm_api.apps.resources.views import _check_overallocation

        res = _load(project, user, spans)
        cap = res.max_units
        peak, _day = peak_concurrent_units(
            [Allocation(Decimal("0.4"), s, e) for s, e in spans],
            project.calendar.working_days,
            [],
        )
        assert (peak > cap) is over  # the oracle itself

        warned = any(
            w["code"] == "resource_overallocated"
            for w in _check_overallocation(res, str(project.pk))
        )
        resp = client.get(f"/api/v1/projects/{project.pk}/attention/")
        fed = any(i["type"] == "overallocation" for i in resp.data["items"])
        flagged = all(_flags(client, project))
        assert warned is fed is over
        assert flagged is over
