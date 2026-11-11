"""Bare-assignee and Resource.user keying for the two remaining overallocation reads (#3059).

``assignee_is_overallocated`` (task list) and the attention feed's overallocation
bucket summed ``TaskResource.units`` only, so a task whose sole assignment signal is
``Task.assignee`` contributed zero load (the #3047 defect on ``_check_overallocation``).
The task-list flag additionally measured the units of *any* resource on a task the user
owns instead of the user's own resources. Each case pairs a control with its defect.
"""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus, TaskType
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()

DAY = (date(2026, 3, 2), date(2026, 3, 6))
APRIL = (date(2026, 4, 13), date(2026, 4, 17))


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std", working_days=31, hours_per_day=8.0)
    return Project.objects.create(name="Atlas", start_date=date(2026, 3, 2), calendar=cal)


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="u_3059", password="pw")


@pytest.fixture
def client(user: Any, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _task(project: Project, assignee: Any, name: str, span: tuple[date, date] = DAY) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        assignee=assignee,
        status=TaskStatus.IN_PROGRESS,
        early_start=span[0],
        early_finish=span[1],
    )


def _rows(client: APIClient, project: Project) -> dict[str, dict[str, Any]]:
    resp = client.get(f"/api/v1/tasks/?project={project.pk}&page_size=50")
    assert resp.status_code == 200, resp.content
    rows = resp.data["results"] if isinstance(resp.data, dict) else resp.data
    return {r["name"]: r for r in rows}


def _attention(client: APIClient, project: Project) -> list[dict[str, Any]]:
    resp = client.get(f"/api/v1/projects/{project.pk}/attention/")
    assert resp.status_code == 200, resp.content
    items = resp.json()
    items = items.get("items", items) if isinstance(items, dict) else items
    return [i for i in items if i.get("type") == "overallocation"]


@pytest.mark.django_db
class TestTaskListFlag:
    def test_bare_assignee_task_counts_as_full_time(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        # 0.6 tracked + a bare task (estimated 1.0) = 1.6 > 1.0 on the same days.
        # Before the fix the bare task was invisible and the sum stayed at 0.6.
        res = Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
        TaskResource.objects.create(
            task=_task(project, user, "tracked"), resource=res, units=Decimal("0.6")
        )
        _task(project, user, "bare")
        rows = _rows(client, project)
        assert rows["tracked"]["assignee_is_overallocated"] is True
        assert rows["bare"]["assignee_is_overallocated"] is True
        assert rows["bare"]["assignee_load_includes_estimate"] is True

    def test_tracked_only_load_is_not_an_estimate(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        res = Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
        TaskResource.objects.create(
            task=_task(project, user, "tracked"), resource=res, units=Decimal("0.6")
        )
        row = _rows(client, project)["tracked"]
        assert row["assignee_is_overallocated"] is False
        assert row["assignee_load_includes_estimate"] is False

    def test_bare_tasks_on_disjoint_days_are_not_flagged(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        _task(project, user, "a", (date(2026, 3, 2), date(2026, 3, 3)))
        _task(project, user, "b", (date(2026, 3, 9), date(2026, 3, 10)))
        assert not any(r["assignee_is_overallocated"] for r in _rows(client, project).values())

    def test_bare_tasks_against_half_time_capacity(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        Resource.objects.create(name="Ada", max_units=Decimal("0.5"), user=user)
        _task(project, user, "bare")
        assert _rows(client, project)["bare"]["assignee_is_overallocated"] is True

    def test_other_peoples_resources_on_my_task_do_not_load_me(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        # Bob owns the task; Alice and Carol (not linked to Bob) hold 1.0 each. Bob's
        # own resource holds 0.5. The old read summed all three (2.5) and flagged Bob.
        bob_res = Resource.objects.create(name="Bob", max_units=Decimal("1.0"), user=user)
        alice = Resource.objects.create(name="Alice", max_units=Decimal("1.0"))
        carol = Resource.objects.create(name="Carol", max_units=Decimal("1.0"))
        t = _task(project, user, "shared")
        TaskResource.objects.create(task=t, resource=bob_res, units=Decimal("0.5"))
        TaskResource.objects.create(task=t, resource=alice, units=Decimal("1.0"))
        TaskResource.objects.create(task=t, resource=carol, units=Decimal("1.0"))
        assert _rows(client, project)["shared"]["assignee_is_overallocated"] is False

    def test_own_load_on_tasks_owned_by_others_counts(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        other = User.objects.create_user(username="other_3059", password="pw")
        bob_res = Resource.objects.create(name="Bob", max_units=Decimal("1.0"), user=user)
        mine = _task(project, user, "mine")
        theirs = _task(project, other, "theirs")
        TaskResource.objects.create(task=mine, resource=bob_res, units=Decimal("0.7"))
        TaskResource.objects.create(task=theirs, resource=bob_res, units=Decimal("0.7"))
        assert _rows(client, project)["mine"]["assignee_is_overallocated"] is True

    def test_deactivated_resource_row_is_not_resurrected_as_a_bare_estimate(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        res = Resource.objects.create(
            name="Ada", max_units=Decimal("1.0"), user=user, is_deleted=True
        )
        TaskResource.objects.create(
            task=_task(project, user, "a"), resource=res, units=Decimal("0.9")
        )
        TaskResource.objects.create(
            task=_task(project, user, "b"), resource=res, units=Decimal("0.9")
        )
        rows = _rows(client, project)
        assert rows["a"]["assignee_is_overallocated"] is False
        assert rows["a"]["assignee_load_includes_estimate"] is False

    def test_off_peak_estimate_is_not_disclosed(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        # The 120% peak is week 1 and made only of tracked units; the bare task sits
        # alone in April at 100%. The flag is right, the estimate caveat would not be.
        res = Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
        for name in ("t1", "t2"):
            TaskResource.objects.create(
                task=_task(project, user, name), resource=res, units=Decimal("0.6")
            )
        _task(project, user, "april", APRIL)
        rows = _rows(client, project)
        assert all(r["assignee_is_overallocated"] is True for r in rows.values())
        assert not any(r["assignee_load_includes_estimate"] for r in rows.values())

    def test_estimate_on_the_peak_day_is_disclosed_for_a_tracked_anchor(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        # The bare task starts before the tracked one and spans its start, so the
        # over-capacity anchor is the TRACKED task's start day.
        res = Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
        TaskResource.objects.create(
            task=_task(project, user, "tracked", (date(2026, 3, 4), date(2026, 3, 6))),
            resource=res,
            units=Decimal("0.6"),
        )
        _task(project, user, "bare", (date(2026, 2, 23), date(2026, 3, 5)))
        Task.objects.filter(name="bare").update(early_start=date(2026, 2, 23))
        row = _rows(client, project)["tracked"]
        assert row["assignee_is_overallocated"] is True
        assert row["assignee_load_includes_estimate"] is True


@pytest.mark.django_db
class TestAttentionBucket:
    def test_bare_assignee_task_pushes_a_resource_over_capacity(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        res = Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
        TaskResource.objects.create(
            task=_task(project, user, "tracked"), resource=res, units=Decimal("0.6")
        )
        assert _attention(client, project) == []
        _task(project, user, "bare")
        items = _attention(client, project)
        assert [i["task_name"] for i in items] == ["Ada"]
        assert "no tracked units" in items[0]["detail"]

    def test_resource_with_only_bare_work_is_still_a_candidate(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        Resource.objects.create(name="Ada", max_units=Decimal("0.5"), user=user)
        _task(project, user, "bare")
        assert [i["task_name"] for i in _attention(client, project)] == ["Ada"]

    def test_unlinked_assignee_is_unaffected(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        Resource.objects.create(name="Ada", max_units=Decimal("0.5"))  # no user link
        _task(project, user, "bare")
        assert _attention(client, project) == []

    def test_off_peak_estimate_is_not_disclosed(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        res = Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
        for name in ("t1", "t2"):
            TaskResource.objects.create(
                task=_task(project, user, name), resource=res, units=Decimal("0.6")
            )
        _task(project, user, "april", APRIL)
        items = _attention(client, project)
        assert [i["task_name"] for i in items] == ["Ada"]
        assert "120%" in items[0]["detail"]
        assert "no tracked units" not in items[0]["detail"]

    @pytest.mark.parametrize(
        "update",
        [
            {"status": TaskStatus.BACKLOG},
            {"type": TaskType.EPIC},
            {"is_recurring": True},
        ],
        ids=["backlog", "epic", "recurring"],
    )
    def test_uncommitted_task_does_not_load_the_tracked_pass(
        self, client: APIClient, project: Project, user: Any, update: dict[str, Any]
    ) -> None:
        # Same set as the estimate pass and the drawer: Task.committed minus COMPLETE.
        res = Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
        for name in ("work", "parked"):
            TaskResource.objects.create(
                task=_task(project, user, name), resource=res, units=Decimal("0.6")
            )
        assert [i["task_name"] for i in _attention(client, project)] == ["Ada"]
        Task.objects.filter(name="parked").update(**update)
        assert _attention(client, project) == []

    def test_tracked_row_suppresses_the_estimate(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        res = Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
        TaskResource.objects.create(
            task=_task(project, user, "t"), resource=res, units=Decimal("0.5")
        )
        assert _attention(client, project) == []


@pytest.mark.django_db
class TestStatusSetAndGuard:
    def test_on_hold_bare_task_loads_the_assignee(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        # Legacy ON_HOLD is committed, non-COMPLETE work -- the attention feed counts it,
        # so the drawer flag must too (the old NOT_STARTED/IN_PROGRESS/REVIEW list did not).
        Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
        _task(project, user, "active")
        held = _task(project, user, "held")
        Task.objects.filter(pk=held.pk).update(status=TaskStatus.ON_HOLD)
        rows = _rows(client, project)
        assert rows["active"]["assignee_is_overallocated"] is True
        assert rows["held"]["assignee_load_includes_estimate"] is True

    def test_user_load_halves_are_index_usable(
        self, client: APIClient, project: Project, user: Any
    ) -> None:
        """The per-user load set must not be ``assignee = uid OR EXISTS(row of uid)``.

        That OR shape defeated the assignee index and ran the correlated EXISTS over
        every open task in the project per returned row, per anchor and per covering
        day (3-6x slower than the pre-#3059 read, superlinear in project size). With
        sequential scans priced out, the plan must reach the bare half through an
        index condition on ``assignee_id`` and the tracked half through one on the
        resource's ``user_id``, and no filter may OR the assignee test with a subplan.
        A wall-clock bound would be too flaky for CI; the plan shape is the contract.
        """
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        res = Resource.objects.create(name="Ada", max_units=Decimal("1.0"), user=user)
        TaskResource.objects.create(
            task=_task(project, user, "tracked"), resource=res, units=Decimal("0.6")
        )
        _task(project, user, "bare")
        with CaptureQueriesContext(connection) as ctx:
            _rows(client, project)
        sql = next(
            q["sql"]
            for q in ctx.captured_queries
            if q["sql"].startswith("SELECT")
            and '"projects_task"."wbs_path"' in q["sql"]
            and "LIMIT" in q["sql"]
        )
        with connection.cursor() as cur:
            cur.execute("SET LOCAL enable_seqscan = off")
            cur.execute("EXPLAIN (FORMAT JSON) " + sql)
            plan = cur.fetchone()[0]

        conds: list[str] = []
        filters: list[str] = []

        def walk(node: dict[str, Any]) -> None:
            conds.extend(node[k] for k in ("Index Cond", "Recheck Cond") if k in node)
            filters.extend(node[k] for k in ("Filter", "Join Filter") if k in node)
            for child in node.get("Plans", []):
                walk(child)

        walk(plan[0]["Plan"])
        # Tracked half: Resource.user_id = <the row's assignee> is applied as an index
        # condition or a filter (the planner picks; either is fine, the OR is not).
        assert any("user_id = projects_task.assignee_id" in c for c in conds + filters), (
            conds,
            filters,
        )
        # Bare half: the assignee test is never one arm of an OR whose other arm is a
        # subplan -- the shape that cannot use any index for either arm.
        arm = r"\(assignee_id = [\w.]+\)"
        sub = r"\(?(?:EXISTS\s*\()?\(?(?:alternatives: |hashed )?SubPlan"
        old_shape = re.compile(rf"{arm} OR {sub}|{sub}[^()]*\)+ OR {arm}")
        offending = [f for f in filters if old_shape.search(f)]
        assert offending == [], offending
