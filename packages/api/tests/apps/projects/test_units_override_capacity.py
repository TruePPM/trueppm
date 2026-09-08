"""Every per-project capacity read applies ``ProjectResource.units_override`` (#3574).

The daily engine's own coverage lives in ``test_utilization.py`` and the heat map's in
``test_heatmap.py``. This module covers the surfaces that do *not* go through the
engine and each carried their own copy of the capacity comparison:

  - ``GET projects/<pk>/resource-allocation/`` — the published ``max_units``
  - ``GET projects/<pk>/attention/`` — ``_overallocation_items``
  - ``TaskSerializer.assignee_is_overallocated`` — was a hardcoded ``1.0``
  - ``POST /task-resources/`` — ``_check_overallocation``'s write-time warning
  - ``Sprint`` capacity preflight — ``capacity_summary`` and its batched twin

plus the deliberate exception: ``GET programs/<pk>/resource-contention/`` is
cross-project, has no single project's override to apply, and keeps
``Resource.max_units``.

Each positive case is paired with a negative control at the same load and no
override, so a passing assertion cannot be explained by the load alone.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Program, Project, Sprint, Task, TaskStatus
from trueppm_api.apps.projects.services import capacity_summaries_for_sprints, capacity_summary
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def cal(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", working_days=31, hours_per_day=8.0)


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="uo_3574", password="pw")


@pytest.fixture
def project(cal: Calendar) -> Project:
    # 2026-03-02 is a Monday.
    return Project.objects.create(name="Atlas", start_date=date(2026, 3, 2), calendar=cal)


@pytest.fixture
def client(owner: Any, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _resource(name: str, *, max_units: str = "1.0", user: Any = None) -> Resource:
    return Resource.objects.create(name=name, max_units=Decimal(max_units), user=user)


def _roster(project: Project, resource: Resource, units_override: str | None) -> ProjectResource:
    return ProjectResource.objects.create(
        project=project,
        resource=resource,
        units_override=Decimal(units_override) if units_override is not None else None,
    )


def _task(
    project: Project,
    *,
    name: str = "T",
    start: date = date(2026, 3, 2),
    days: int = 5,
    status: str = TaskStatus.NOT_STARTED,
    assignee: Any = None,
    wbs: str = "1",
) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=days,
        early_start=start,
        early_finish=start + timedelta(days=days - 1),
        status=status,
        assignee=assignee,
        wbs_path=wbs,
    )


# ---------------------------------------------------------------------------
# resource-allocation — the published per-project capacity
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestResourceAllocationPublishesEffectiveCapacity:
    """ADR-0031 puts the overallocation verdict in the client, so the capacity this
    endpoint publishes IS the verdict. Publishing the raw default made the client
    contradict the heat map."""

    def url(self, project: Project) -> str:
        return f"/api/v1/projects/{project.pk}/resource-allocation/"

    def test_override_is_published(self, client: APIClient, project: Project) -> None:
        resource = _resource("Ada")
        _roster(project, resource, "0.5")
        TaskResource.objects.create(task=_task(project), resource=resource, units=Decimal("0.5"))

        resp = client.get(self.url(project))
        assert resp.status_code == 200
        assert resp.data["resources"][0]["max_units"] == "0.50"

    def test_no_override_publishes_the_resource_default(
        self, client: APIClient, project: Project
    ) -> None:
        resource = _resource("Ada")
        _roster(project, resource, None)
        TaskResource.objects.create(task=_task(project), resource=resource, units=Decimal("0.5"))

        resp = client.get(self.url(project))
        assert resp.status_code == 200
        assert resp.data["resources"][0]["max_units"] == "1.00"

    def test_zero_override_is_published_as_zero(self, client: APIClient, project: Project) -> None:
        """The truthiness trap: ``units_override or max_units`` would print 1.00."""
        resource = _resource("Ada")
        _roster(project, resource, "0")
        TaskResource.objects.create(task=_task(project), resource=resource, units=Decimal("0.5"))

        resp = client.get(self.url(project))
        assert resp.data["resources"][0]["max_units"] == "0.00"


# ---------------------------------------------------------------------------
# attention feed — _overallocation_items
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAttentionOverallocationUsesEffectiveCapacity:
    def url(self, project: Project) -> str:
        return f"/api/v1/projects/{project.pk}/attention/"

    def _items(self, client: APIClient, project: Project) -> list[dict[str, Any]]:
        resp = client.get(self.url(project))
        assert resp.status_code == 200
        return [i for i in resp.data["items"] if i["type"] == "overallocation"]

    def test_over_the_override_but_under_the_default_is_flagged(
        self, client: APIClient, project: Project
    ) -> None:
        resource = _resource("Ada")
        _roster(project, resource, "0.5")
        TaskResource.objects.create(task=_task(project), resource=resource, units=Decimal("0.6"))

        items = self._items(client, project)
        assert len(items) == 1
        assert items[0]["task_name"] == "Ada"

    def test_the_same_load_is_silent_without_the_override(
        self, client: APIClient, project: Project
    ) -> None:
        """Negative control — 0.6 against a 1.0 default is not overallocation."""
        resource = _resource("Ada")
        _roster(project, resource, None)
        TaskResource.objects.create(task=_task(project), resource=resource, units=Decimal("0.6"))

        assert self._items(client, project) == []

    def test_an_override_above_the_default_suppresses_a_stale_warning(
        self, client: APIClient, project: Project
    ) -> None:
        """The override widens capacity as well as narrowing it."""
        resource = _resource("Ada")
        _roster(project, resource, "1.5")
        TaskResource.objects.create(task=_task(project), resource=resource, units=Decimal("1.2"))

        assert self._items(client, project) == []


# ---------------------------------------------------------------------------
# assignee_is_overallocated — was a hardcoded 1.0
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAssigneeIsOverallocatedUsesEffectiveCapacity:
    """The badge is keyed on ``Task.assignee`` (a User); the bridge to a capacity is
    ``Resource.user``. Before #3574 it compared every assignee's committed units
    against a literal 1.0, so it could not agree with any other surface."""

    def _flag(self, client: APIClient, task: Task) -> bool:
        resp = client.get(f"/api/v1/tasks/{task.pk}/")
        assert resp.status_code == 200
        return bool(resp.data["assignee_is_overallocated"])

    def test_over_the_override_but_under_one_is_flagged(
        self, client: APIClient, project: Project, owner: Any
    ) -> None:
        resource = _resource("Ada", user=owner)
        _roster(project, resource, "0.5")
        task = _task(project, assignee=owner)
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.6"))

        assert self._flag(client, task) is True

    def test_the_same_load_is_not_flagged_without_the_override(
        self, client: APIClient, project: Project, owner: Any
    ) -> None:
        """Negative control: 0.6 against a 1.0 default is the old hardcoded verdict
        too, so this pins that the fix did not simply flip the default."""
        resource = _resource("Ada", user=owner)
        _roster(project, resource, None)
        task = _task(project, assignee=owner)
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.6"))

        assert self._flag(client, task) is False

    def test_a_generous_resource_default_raises_the_bar(
        self, client: APIClient, project: Project, owner: Any
    ) -> None:
        """No roster override, but a 1.5 FTE resource: 1.2 units is within capacity
        and the hardcoded 1.0 called it overallocated."""
        resource = _resource("Ada", max_units="1.5", user=owner)
        task = _task(project, assignee=owner)
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.2"))

        assert self._flag(client, task) is False

    def test_an_assignee_with_no_resource_row_keeps_the_1_0_default(
        self, client: APIClient, project: Project, owner: Any
    ) -> None:
        """Nothing links this user to a capacity, so full time stands in — exactly
        the population the old hardcoded value was right for."""
        unlinked = _resource("Equipment")
        task = _task(project, assignee=owner)
        TaskResource.objects.create(task=task, resource=unlinked, units=Decimal("1.2"))

        assert self._flag(client, task) is True

    def test_an_override_on_another_project_does_not_leak(
        self, client: APIClient, project: Project, cal: Calendar, owner: Any
    ) -> None:
        other = Project.objects.create(name="Other", start_date=date(2026, 3, 2), calendar=cal)
        resource = _resource("Ada", user=owner)
        _roster(other, resource, "0.5")
        task = _task(project, assignee=owner)
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.6"))

        assert self._flag(client, task) is False

    def test_a_live_roster_row_wins_even_for_a_soft_deleted_resource(
        self, client: APIClient, project: Project, owner: Any
    ) -> None:
        """The two capacity candidates filter soft-deletes asymmetrically on purpose.

        A live roster row is an explicit per-project statement and stands on its own,
        so it applies even when the catalog row behind it has been retired. Only the
        user-link FALLBACK excludes soft-deleted resources, so a retired resource
        nobody put on this project cannot supply a capacity. Pinned because the
        asymmetry reads like an oversight.
        """
        resource = _resource("Ada", user=owner)
        _roster(project, resource, "0.5")
        resource.is_deleted = True
        resource.save(update_fields=["is_deleted"])
        task = _task(project, assignee=owner)
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.6"))

        assert self._flag(client, task) is True

    def test_a_soft_deleted_resource_with_no_roster_row_falls_back_to_1_0(
        self, client: APIClient, project: Project, owner: Any
    ) -> None:
        """The other half of the asymmetry: no roster row, retired resource at 1.5 —
        the fallback skips it, so the flat 1.0 stands and 1.2 units is over."""
        resource = _resource("Ada", max_units="1.5", user=owner)
        resource.is_deleted = True
        resource.save(update_fields=["is_deleted"])
        task = _task(project, assignee=owner)
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.2"))

        assert self._flag(client, task) is True


# ---------------------------------------------------------------------------
# _check_overallocation — the write-time warning
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAssignmentWarningUsesEffectiveCapacity:
    def _post(self, client: APIClient, task: Task, resource: Resource, units: str) -> Any:
        return client.post(
            "/api/v1/task-resources/",
            {"task": str(task.pk), "resource": str(resource.pk), "units": units},
        )

    def test_warns_over_the_override(self, client: APIClient, project: Project) -> None:
        resource = _resource("Ada")
        _roster(project, resource, "0.5")
        resp = self._post(client, _task(project), resource, "0.6")
        assert resp.status_code == 201
        codes = [w["code"] for w in resp.data["warnings"]]
        assert codes == ["resource_overallocated"]
        # The warning quotes the capacity it judged against; quoting the raw default
        # while judging against the override would be its own contradiction.
        assert "capacity: 50%" in resp.data["warnings"][0]["detail"]

    def test_silent_at_the_same_load_without_the_override(
        self, client: APIClient, project: Project
    ) -> None:
        resource = _resource("Ada")
        _roster(project, resource, None)
        resp = self._post(client, _task(project), resource, "0.6")
        assert resp.status_code == 201
        assert resp.data["warnings"] == []

    def test_an_override_above_the_default_suppresses_the_warning(
        self, client: APIClient, project: Project
    ) -> None:
        resource = _resource("Ada", max_units="1.0")
        _roster(project, resource, "1.5")
        resp = self._post(client, _task(project), resource, "1.2")
        assert resp.status_code == 201
        assert resp.data["warnings"] == []


# ---------------------------------------------------------------------------
# Sprint capacity preflight — capacity_summary and its batched twin
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSprintCapacityUsesEffectiveCapacity:
    """A sprint belongs to exactly one project, so the per-project override is the
    right capacity for its availability figures."""

    def _sprint(self, project: Project) -> Sprint:
        return Sprint.objects.create(
            project=project,
            name="S1",
            start_date=date(2026, 3, 2),
            finish_date=date(2026, 3, 6),
        )

    def _member(self, summary: dict[str, Any]) -> dict[str, Any]:
        assert len(summary["members"]) == 1
        return dict(summary["members"][0])

    def test_available_hours_follow_the_override(self, project: Project) -> None:
        sprint = self._sprint(project)
        resource = _resource("Ada")
        _roster(project, resource, "0.5")
        task = _task(project, days=5)
        task.sprint = sprint
        task.save(update_fields=["sprint"])
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.5"))

        member = self._member(capacity_summary(sprint))
        # 0.5 FTE x 5 working days x 8 h = 20 h, not the 40 h a 1.0 default gives.
        assert member["available_hours"] == 20.0
        assert member["committed_hours"] == 20.0
        assert member["ratio"] == 1.0

    def test_no_override_keeps_the_resource_default(self, project: Project) -> None:
        sprint = self._sprint(project)
        resource = _resource("Ada")
        _roster(project, resource, None)
        task = _task(project, days=5)
        task.sprint = sprint
        task.save(update_fields=["sprint"])
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.5"))

        member = self._member(capacity_summary(sprint))
        assert member["available_hours"] == 40.0
        assert member["ratio"] == 0.5

    def test_batched_twin_agrees_with_the_per_sprint_path(self, project: Project) -> None:
        """The #1012 batched path must not diverge — it is the same math or it is a
        second surface that can disagree."""
        sprint = self._sprint(project)
        resource = _resource("Ada")
        _roster(project, resource, "0.5")
        task = _task(project, days=5)
        task.sprint = sprint
        task.save(update_fields=["sprint"])
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.5"))

        batched = capacity_summaries_for_sprints(Sprint.objects.filter(pk=sprint.pk))
        assert batched[sprint.pk] == capacity_summary(sprint)
        assert batched[sprint.pk]["members"][0]["available_hours"] == 20.0


# ---------------------------------------------------------------------------
# The deliberate exception: cross-project reads keep Resource.max_units
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCrossProjectContentionKeepsTheResourceDefault:
    """A per-project override is a slice of one person's time, not a statement about
    their total capacity, and the slices are not additive — so the program-scoped
    contention span states the whole person. Pinned so the ruling is visible in the
    suite rather than only in a docstring."""

    def test_contention_publishes_the_resource_default(
        self, client: APIClient, owner: Any, cal: Calendar, project: Project
    ) -> None:
        program = Program.objects.create(name="Prog", code="PRG")
        project.program = program
        project.save(update_fields=["program"])
        ProgramMembership.objects.create(program=program, user=owner, role=Role.SCHEDULER)

        resource = _resource("Ada")
        _roster(project, resource, "0.5")
        TaskResource.objects.create(task=_task(project), resource=resource, units=Decimal("0.5"))

        resp = client.get(f"/api/v1/programs/{program.pk}/resource-contention/")
        assert resp.status_code == 200
        assert resp.data["resources"][0]["max_units"] == "1.00"


# ---------------------------------------------------------------------------
# Query-count guards — the whole design of #3574 is "one roster query, not N"
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCapacityResolutionIsNotPerRow:
    """These assert the count is FLAT as the input grows, not that it equals some
    number: a fixed expectation would pass a per-row lookup at n=1."""

    def test_daily_engine_roster_query_does_not_scale_with_assignments(
        self, project: Project, cal: Calendar
    ) -> None:
        from trueppm_api.apps.projects.utilization import compute_utilization

        one = _resource("Solo")
        _roster(project, one, "0.5")
        TaskResource.objects.create(
            task=_task(project, name="A", wbs="1"), resource=one, units=Decimal("0.5")
        )
        with CaptureQueriesContext(connection) as captured:
            compute_utilization(project, date(2026, 3, 2), date(2026, 3, 6))
        baseline = len(captured)

        for i in range(2, 7):
            extra = _resource(f"Extra {i}")
            _roster(project, extra, "0.5")
            TaskResource.objects.create(
                task=_task(project, name=f"T{i}", wbs=str(i)),
                resource=extra,
                units=Decimal("0.5"),
            )
        with CaptureQueriesContext(connection) as grown:
            compute_utilization(project, date(2026, 3, 2), date(2026, 3, 6))
        assert len(grown) == baseline

    def test_batched_sprint_capacity_does_not_query_per_sprint(
        self, project: Project, cal: Calendar
    ) -> None:
        """The #1012 guard. `capacity_summaries_for_sprints` exists so many sprints
        cost one TaskResource query; threading the override must not add one each.

        Sprints are passed with ``project__calendar`` select_related, which is the
        contract the function's own docstring states — without it the per-sprint
        calendar read is a caller-side N+1 that predates this change and would mask
        the thing being measured.
        """
        resource = _resource("Ada")
        _roster(project, resource, "0.5")

        def _sprint(n: int) -> Sprint:
            sprint = Sprint.objects.create(
                project=project,
                name=f"S{n}",
                start_date=date(2026, 3, 2),
                finish_date=date(2026, 3, 6),
            )
            task = _task(project, name=f"T{n}", wbs=str(n))
            task.sprint = sprint
            task.save(update_fields=["sprint"])
            TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.5"))
            return sprint

        first = _sprint(1)
        with CaptureQueriesContext(connection) as captured:
            capacity_summaries_for_sprints(
                Sprint.objects.select_related("project__calendar").filter(pk=first.pk)
            )
        baseline = len(captured)

        for n in range(2, 6):
            _sprint(n)
        with CaptureQueriesContext(connection) as grown:
            capacity_summaries_for_sprints(Sprint.objects.select_related("project__calendar"))
        assert len(grown) == baseline
