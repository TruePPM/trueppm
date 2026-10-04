"""Tests for the resource utilization endpoint (issue #22).

Covers:
  - Permission gate: VIEWER/MEMBER denied, SCHEDULER+ allowed
  - 409 when no CPM dates exist
  - Correct daily load computation (including units fraction)
  - Calendar-aware working-day exclusion (weekends, exceptions)
  - calendar_differs_from_project flag
  - unassigned_task_count
  - Date window filtering (?start=, ?end=, bad dates, start > end)
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Project,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.utilization import (
    _AVATAR_COLORS,
    Allocation,
    _accumulate_days,
    _count_working_days_in_range,
    _first_working_day_in,
    _initials,
    _load_band,
    _partition_allocations,
    _resource_color,
    _sum_week_hours,
    _weekly_util_for_resource,
    aggregate_utilization_weekly,
    peak_concurrent_units,
)
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def cal(db: object) -> Calendar:
    """Standard Mon–Fri, 8 h/day calendar."""
    return Calendar.objects.create(name="Standard", working_days=31, hours_per_day=8.0)


@pytest.fixture
def project(cal: Calendar) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 3, 2), calendar=cal)


def _auth_client(role: int, project: Project) -> APIClient:
    user = User.objects.create_user(username=f"u{role}", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/utilization/"


def _heatmap_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/resources/heatmap/"


# ---------------------------------------------------------------------------
# Permission gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationPermissions:
    def test_viewer_denied(self, project: Project) -> None:
        c = _auth_client(Role.VIEWER, project)
        assert c.get(_url(project)).status_code == 403

    def test_member_denied(self, project: Project) -> None:
        c = _auth_client(Role.MEMBER, project)
        assert c.get(_url(project)).status_code == 403

    def test_scheduler_allowed(self, project: Project) -> None:
        c = _auth_client(Role.SCHEDULER, project)
        # No tasks → 409 (schedule not run), but auth succeeded
        resp = c.get(_url(project))
        assert resp.status_code in (200, 409)

    def test_admin_allowed(self, project: Project) -> None:
        c = _auth_client(Role.ADMIN, project)
        resp = c.get(_url(project))
        assert resp.status_code in (200, 409)

    def test_unauthenticated_denied(self, project: Project) -> None:
        assert APIClient().get(_url(project)).status_code in (401, 403)

    def test_non_member_denied(self, project: Project) -> None:
        other = User.objects.create_user(username="nobody", password="pw")
        c = APIClient()
        c.force_authenticate(user=other)
        assert c.get(_url(project)).status_code in (403, 404)


# ---------------------------------------------------------------------------
# 409 — schedule not computed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_409_when_no_cpm_dates(project: Project) -> None:
    Task.objects.create(project=project, name="T1", duration=5)
    c = _auth_client(Role.SCHEDULER, project)
    resp = c.get(_url(project))
    assert resp.status_code == 409
    assert "scheduler" in resp.data["detail"].lower()


# ---------------------------------------------------------------------------
# Core computation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationComputation:
    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="Std", working_days=31, hours_per_day=8.0)
        self.project = Project.objects.create(
            name="P", start_date=date(2026, 3, 2), calendar=self.cal
        )

    def _client(self, role: int = Role.SCHEDULER) -> APIClient:
        return _auth_client(role, self.project)

    def test_single_resource_single_task(self) -> None:
        """Mon–Fri task: 5 working days × 8 h/day × 1.0 units = 8 h/day each."""
        resource = Resource.objects.create(name="Alice", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=5,
            early_start=date(2026, 3, 2),  # Monday
            early_finish=date(2026, 3, 6),  # Friday
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        assert resp.status_code == 200

        data = resp.data
        assert data["project_id"] == str(self.project.pk)
        resources = data["resources"]
        assert len(resources) == 1

        alice = resources[0]
        assert alice["resource_name"] == "Alice"
        assert alice["max_units"] == "1.00"
        days = alice["days"]
        # Mon–Fri should all be present; weekend excluded
        assert len(days) == 5
        for iso_date in ("2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"):
            assert iso_date in days
            assert days[iso_date]["hours"] == pytest.approx(8.0)

    def test_an_unassigned_task_does_not_abort_processing_later_assigned_ones(self) -> None:
        """Task has no ``Meta.ordering`` of its own choosing here — it is sorted
        by ``wbs_path``/``name`` (model default), so naming controls iteration
        order deterministically. An unassigned task must be *skipped*, not treated
        as a reason to stop looking at the rest of the queryset: if the loop
        abandoned the scan on the first unassigned task instead of continuing
        past it, every assigned task sorted after it would silently lose its
        load — exactly what the module docstring's "windowed by the task's span"
        contract assumes never happens.
        """
        Task.objects.create(
            project=self.project,
            name="A-NoAssignment",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        resource = Resource.objects.create(name="Carol", max_units="1.0")
        task_b = Task.objects.create(
            project=self.project,
            name="B-Assigned",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task_b, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        assert resp.status_code == 200
        assert len(resp.data["resources"]) == 1
        assert resp.data["resources"][0]["resource_name"] == "Carol"
        assert resp.data["resources"][0]["days"]["2026-03-02"]["hours"] == pytest.approx(8.0)

    def test_fractional_units(self) -> None:
        """0.5 units → 4 h/day."""
        resource = Resource.objects.create(name="Bob", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="0.5")

        resp = self._client().get(_url(self.project))
        days = resp.data["resources"][0]["days"]
        assert days["2026-03-02"]["hours"] == pytest.approx(4.0)

    def test_weekend_excluded(self) -> None:
        """Task spanning Mon–Sun: only Mon–Fri get load (working_days=31)."""
        resource = Resource.objects.create(name="Carol", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=5,
            early_start=date(2026, 3, 2),  # Monday
            early_finish=date(2026, 3, 8),  # Sunday
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        days = resp.data["resources"][0]["days"]
        assert "2026-03-07" not in days  # Saturday
        assert "2026-03-08" not in days  # Sunday
        assert len(days) == 5

    def test_calendar_exception_excluded(self) -> None:
        """A day in a CalendarException range is not a working day."""
        # Tuesday 2026-03-03 is a holiday
        CalendarException.objects.create(
            calendar=self.cal,
            exc_start=date(2026, 3, 3),
            exc_end=date(2026, 3, 3),
            description="Holiday",
        )
        resource = Resource.objects.create(name="Dave", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=5,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 6),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        days = resp.data["resources"][0]["days"]
        assert "2026-03-03" not in days  # exception day excluded
        assert len(days) == 4  # Mon + Wed–Fri

    def test_resource_own_calendar(self) -> None:
        """Resource with its own calendar (Mon–Fri, 6 h/day) → 6 h/day."""
        res_cal = Calendar.objects.create(name="Part-time", working_days=31, hours_per_day=6.0)
        resource = Resource.objects.create(name="Eve", max_units="1.0", calendar=res_cal)
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        resources = resp.data["resources"]
        assert resources[0]["days"]["2026-03-02"]["hours"] == pytest.approx(6.0)

    def test_calendar_differs_flag(self) -> None:
        """Flag is true when resource.calendar differs from project.calendar."""
        res_cal = Calendar.objects.create(name="Other", working_days=31, hours_per_day=8.0)
        resource = Resource.objects.create(name="Frank", max_units="1.0", calendar=res_cal)
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        assert resp.data["resources"][0]["calendar_differs_from_project"] is True

    def test_calendar_differs_false_when_same(self) -> None:
        """Flag is false when resource.calendar is the same as project.calendar."""
        resource = Resource.objects.create(name="Grace", max_units="1.0", calendar=self.cal)
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        assert resp.data["resources"][0]["calendar_differs_from_project"] is False

    def test_unassigned_task_count(self) -> None:
        """Tasks with CPM dates but no TaskResource are counted as unassigned."""
        Task.objects.create(
            project=self.project,
            name="Unassigned",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        resp = self._client().get(_url(self.project))
        assert resp.data["unassigned_task_count"] == 1
        assert resp.data["resources"] == []

    def test_unassigned_count_excludes_soft_deleted_tasks(self) -> None:
        """A soft-deleted task with no assignment must not inflate the count."""
        Task.objects.create(
            project=self.project,
            name="Gone",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
            is_deleted=True,
        )
        resp = self._client().get(_url(self.project), {"start": "2026-03-02", "end": "2026-03-02"})
        assert resp.status_code == 200
        assert resp.data["unassigned_task_count"] == 0

    def test_unassigned_count_excludes_tasks_outside_the_window(self) -> None:
        """An unassigned task scheduled outside the queried window must not count
        as unassigned *in that window* — the span filter applies to this count
        exactly as it does to the daily load query."""
        Task.objects.create(
            project=self.project,
            name="Elsewhen",
            duration=1,
            early_start=date(2026, 1, 5),
            early_finish=date(2026, 1, 9),
        )
        resp = self._client().get(_url(self.project), {"start": "2026-03-01", "end": "2026-03-31"})
        assert resp.status_code == 200
        assert resp.data["unassigned_task_count"] == 0

    def test_unassigned_count_excludes_tasks_cpm_has_never_touched(self) -> None:
        """``early_start__isnull=False`` is the query's "has CPM run at all" gate
        — independent of ``is_deleted`` and of the window filter below it. A task
        CPM has never scheduled has no early_start, by definition no CPM dates,
        and so by the field's own contract cannot be "unassigned in this window"
        even if some other date happens to be populated (e.g. a baseline import
        that wrote scheduled_start/early_finish before the engine first ran).
        """
        Task.objects.create(
            project=self.project,
            name="NeverScheduled",
            duration=1,
            early_start=None,
            scheduled_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        resp = self._client().get(_url(self.project), {"start": "2026-03-01", "end": "2026-03-31"})
        assert resp.status_code == 200
        assert resp.data["unassigned_task_count"] == 0

    def test_two_tasks_same_resource_accumulates(self) -> None:
        """Two overlapping tasks for the same resource add up on shared days."""
        resource = Resource.objects.create(name="Hank", max_units="2.0")
        task_ids = []
        for name in ("T1", "T2"):
            task = Task.objects.create(
                project=self.project,
                name=name,
                duration=1,
                early_start=date(2026, 3, 2),
                early_finish=date(2026, 3, 2),
            )
            task_ids.append(str(task.pk))
            TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        assert resp.data["resources"][0]["days"]["2026-03-02"]["hours"] == pytest.approx(16.0)
        # The real task pks, not a placeholder each call could silently swap out.
        assert sorted(resp.data["resources"][0]["days"]["2026-03-02"]["tasks"]) == sorted(task_ids)

    def test_full_response_shape_matches_the_documented_contract(self) -> None:
        """The module docstring's JSON contract names resource_id, hours_per_day,
        calendar_id and window.start/end explicitly — assert every one of them,
        not just the fields exercised incidentally by other tests."""
        resource = Resource.objects.create(name="Shape", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project), {"start": "2026-03-02", "end": "2026-03-02"})
        assert resp.status_code == 200
        data = resp.data
        assert data["window"]["start"] == "2026-03-02"
        assert data["window"]["end"] == "2026-03-02"
        row = data["resources"][0]
        assert row["resource_id"] == str(resource.pk)
        assert row["hours_per_day"] == pytest.approx(8.0)
        assert row["calendar_id"] is None  # no own calendar -> inherits project's

    def test_job_role_is_echoed_on_the_weekly_heatmap(self) -> None:
        """``job_role`` is part of ``_init_resource_row``'s shared row, but only
        the weekly heatmap (not the daily ``/utilization/`` response) forwards
        it — see ``aggregate_utilization_weekly``'s ``resources_out``."""
        resource = Resource.objects.create(name="Role", max_units="1.0", job_role="Engineer")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")
        resp = self._client().get(_heatmap_url(self.project), {"start": "2026-03-02"})
        assert resp.status_code == 200
        assert resp.data["resources"][0]["job_role"] == "Engineer"

    def test_job_role_defaults_to_empty_string_not_a_placeholder(self) -> None:
        resource = Resource.objects.create(name="NoRole", max_units="1.0", job_role="")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")
        resp = self._client().get(_heatmap_url(self.project), {"start": "2026-03-02"})
        assert resp.status_code == 200
        assert resp.data["resources"][0]["job_role"] == ""

    def test_resource_with_its_own_calendar_echoes_its_id(self) -> None:
        own_cal = Calendar.objects.create(name="Own", working_days=31, hours_per_day=8.0)
        resource = Resource.objects.create(name="OwnCal", max_units="1.0", calendar=own_cal)
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")
        resp = self._client().get(_url(self.project))
        assert resp.data["resources"][0]["calendar_id"] == str(own_cal.pk)

    def test_resource_inheriting_the_project_calendar_never_differs(self) -> None:
        """A resource with no calendar of its own always inherits the project's —
        that inherit path must report calendar_differs_from_project=False, never
        hardcode True regardless of the (non-)comparison it's making."""
        resource = Resource.objects.create(name="Inherits", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")
        resp = self._client().get(_url(self.project))
        assert resp.data["resources"][0]["calendar_differs_from_project"] is False

    def test_deactivated_resources_assignment_is_excluded(self) -> None:
        """The Prefetch filters to resource__is_deleted=False (#3572) — without it
        a deactivated person's retained assignment would still draw load here."""
        resource = Resource.objects.create(name="Gone", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")
        resource.is_deleted = True
        resource.save()

        resp = self._client().get(_url(self.project))
        assert resp.data["resources"] == []

    def test_soft_deleted_task_contributes_no_load(self) -> None:
        resource = Resource.objects.create(name="Lives", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
            is_deleted=True,
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        # Explicit window: with every task soft-deleted, the auto-detected-span
        # branch would 409 ("no CPM dates") before this filter is ever reached.
        resp = self._client().get(_url(self.project), {"start": "2026-03-02", "end": "2026-03-02"})
        assert resp.status_code == 200
        assert resp.data["resources"] == []

    def test_task_cpm_has_never_touched_contributes_no_load_even_if_assigned(
        self,
    ) -> None:
        """Same gate as ``test_unassigned_count_excludes_tasks_cpm_has_never_touched``,
        on the daily engine's own query this time: a task with no early_start is
        not "scheduled" by this module's own definition, so an assignment on it
        must not draw load even if scheduled_start/early_finish are populated
        (e.g. by a baseline import that ran before the engine first did)."""
        resource = Resource.objects.create(name="NeverScheduled", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=None,
            scheduled_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project), {"start": "2026-03-01", "end": "2026-03-31"})
        assert resp.status_code == 200
        assert resp.data["resources"] == []

    def test_task_entirely_outside_the_window_produces_no_resource_row(self) -> None:
        """A task scheduled before the queried window must not just show empty
        days for its resource — the resource must not appear at all, which only
        holds if the query itself excludes it rather than relying on the
        per-day clamp to produce an empty range."""
        resource = Resource.objects.create(name="Elsewhen", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 1, 5),
            early_finish=date(2026, 1, 9),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project), {"start": "2026-03-01", "end": "2026-03-31"})
        assert resp.data["resources"] == []

    def test_a_task_scheduled_entirely_after_the_window_produces_no_resource_row(
        self,
    ) -> None:
        """The mirror of the "before" case above: the upper bound
        (``_span_start__lte=window_end``) is a SEPARATE filter clause from the
        lower bound (``early_finish__gte=window_start``) in both the daily
        engine's main query and the unassigned-count query — a task entirely
        AFTER the window satisfies the lower bound trivially (its finish is
        always >= any earlier window start) and is excluded only by the upper
        bound, which a "before" fixture can never exercise."""
        resource = Resource.objects.create(name="Later", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 5, 4),
            early_finish=date(2026, 5, 8),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project), {"start": "2026-03-01", "end": "2026-03-31"})
        assert resp.data["resources"] == []

    def test_unassigned_count_excludes_a_task_scheduled_entirely_after_the_window(
        self,
    ) -> None:
        """Same upper-bound gap as the sibling test above, on the unassigned-
        count query's own copy of the span filter."""
        Task.objects.create(
            project=self.project,
            name="LaterUnassigned",
            duration=1,
            early_start=date(2026, 5, 4),
            early_finish=date(2026, 5, 8),
        )
        resp = self._client().get(_url(self.project), {"start": "2026-03-01", "end": "2026-03-31"})
        assert resp.data["unassigned_task_count"] == 0

    def test_a_task_with_assignments_but_no_working_day_still_reports_false_not_null(
        self,
    ) -> None:
        """A task whose entire span is a weekend has an assignment but accumulates
        zero days — the resource row still exists, and its overallocated flag must
        read back as the boolean False, not a None that never got initialized."""
        resource = Resource.objects.create(name="WeekendOnly", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=2,
            early_start=date(2026, 3, 7),  # Saturday
            early_finish=date(2026, 3, 8),  # Sunday
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        resources = resp.data["resources"]
        assert len(resources) == 1
        assert resources[0]["days"] == {}
        assert resources[0]["overallocated"] is False

    def test_load_pct_rounds_to_one_decimal_not_an_integer(self) -> None:
        """2.01 units against a 2.00-unit resource is 100.5% exactly — a value
        with real precision past the decimal point, so dropping `round`'s ndigits
        (collapsing to an int) is distinguishable from the documented 1-decimal
        contract."""
        resource = Resource.objects.create(name="Precise", max_units="2.00")
        for units in ("1.00", "1.01"):
            task = Task.objects.create(
                project=self.project,
                name=f"T{units}",
                duration=1,
                early_start=date(2026, 3, 2),
                early_finish=date(2026, 3, 2),
            )
            TaskResource.objects.create(task=task, resource=resource, units=units)

        resp = self._client().get(_url(self.project))
        day = resp.data["resources"][0]["days"]["2026-03-02"]
        assert day["load_pct"] == 100.5
        assert day["load_band"] == "critical"
        assert day["overallocated"] is True
        assert resp.data["resources"][0]["overallocated"] is True

    def test_load_pct_rounds_to_one_decimal_not_two(self) -> None:
        """1.00 against 0.88 is a repeating decimal (113.636...%) — 1 vs 2 decimal
        places give visibly different values, unlike a boundary that happens to
        round the same at both precisions."""
        resource = Resource.objects.create(name="Repeating", max_units="0.88")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.00")

        resp = self._client().get(_url(self.project))
        assert resp.data["resources"][0]["days"]["2026-03-02"]["load_pct"] == 113.6

    def test_fractional_capacity_below_one_still_computes_a_real_ratio(self) -> None:
        """hours_per_day x max_units = 0.5 — a capacity strictly between 0 and 1.
        The divide-by-zero guard checks `capacity > 0`; if it instead checked
        `capacity > 1` this capacity would wrongly fall into the undefined-ratio
        branch and read back as 0.0 regardless of real load."""
        cal = Calendar.objects.create(name="HalfHour", working_days=31, hours_per_day=0.5)
        resource = Resource.objects.create(name="Tiny", max_units="1.00", calendar=cal)
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.00")

        resp = self._client().get(_url(self.project))
        assert resp.data["resources"][0]["days"]["2026-03-02"]["load_pct"] == 100.0

    def test_resource_without_its_own_calendar_uses_the_real_project_hours(self) -> None:
        """The project calendar here is 7h/day, not the 8h default — if the
        fallback silently ignored project_cal and always used the hardcoded
        default, this would read 8.0 instead."""
        project_cal = Calendar.objects.create(name="SevenHour", working_days=31, hours_per_day=7.0)
        project = Project.objects.create(
            name="SevenHourProject", start_date=date(2026, 3, 2), calendar=project_cal
        )
        resource = Resource.objects.create(name="NoOwnCal", max_units="1.0")
        task = Task.objects.create(
            project=project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = _auth_client(Role.SCHEDULER, project).get(_url(project))
        assert resp.status_code == 200
        assert resp.data["resources"][0]["hours_per_day"] == pytest.approx(7.0)
        assert resp.data["resources"][0]["days"]["2026-03-02"]["hours"] == pytest.approx(7.0)

    def test_project_with_no_calendar_at_all_falls_back_to_the_default(self) -> None:
        """Neither the project nor the resource has a calendar — the engine must
        fall back to the Mon-Fri/8h default rather than dereferencing a None."""
        project = Project.objects.create(
            name="NoCalendarProject", start_date=date(2026, 3, 2), calendar=None
        )
        resource = Resource.objects.create(name="NoCalAnywhere", max_units="1.0")
        task = Task.objects.create(
            project=project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = _auth_client(Role.SCHEDULER, project).get(_url(project))
        assert resp.status_code == 200
        assert resp.data["resources"][0]["hours_per_day"] == pytest.approx(8.0)
        assert resp.data["resources"][0]["days"]["2026-03-02"]["hours"] == pytest.approx(8.0)


# ---------------------------------------------------------------------------
# #2623 / ADR-0752 — utilization windows on the task's SPAN, not the
# remaining-work window, so reporting progress does not delete a person's
# allocated load from the heat map.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationUsesSpanNotRemainingWindow:
    """Since ADR-0132, ``early_start`` is an in-progress task's *remaining-work*
    window — it shrinks toward ``early_finish`` as ``percent_complete`` rises.
    Windowing utilization on it made reporting progress look like shedding
    allocation. ADR-0752's ``scheduled_start`` (paired with ``early_finish``,
    which is always ``scheduled_finish``) carries the task's real span and must
    be what utilization windows on instead. These tests set the CPM fields
    directly to the values the engine would produce at each state — they do
    not run the scheduler — so they isolate ``utilization.py``'s windowing
    logic from engine correctness (covered separately by scheduler-engine
    tests).
    """

    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="SpanCal", working_days=31, hours_per_day=8.0)
        self.project = Project.objects.create(
            name="SpanProj", start_date=date(2026, 3, 2), calendar=self.cal
        )
        self.resource = Resource.objects.create(name="Ivy", max_units="1.0")
        self.client = _auth_client(Role.SCHEDULER, self.project)

    def _assign(self, task: Task) -> None:
        TaskResource.objects.create(task=task, resource=self.resource, units="1.0")

    def _total_hours(self, start: str = "2026-03-02", end: str = "2026-03-05") -> float:
        resp = self.client.get(_url(self.project), {"start": start, "end": end})
        assert resp.status_code == 200
        resources = resp.data["resources"]
        if not resources:
            return 0.0
        return sum(day["hours"] for day in resources[0]["days"].values())

    def test_load_stable_across_0_50_100_percent(self) -> None:
        """Same 4-working-day (Mon–Thu) assignment at 0%, 50%, and 100% complete
        must contribute the same total load — the core #2623 regression.

        Pre-fix, this task would contribute 32h at 0%, 16h at 50% (early_start
        shrunk to the last two days), and ~0h at 100% (early_start == early_finish).
        """
        full_span = (date(2026, 3, 2), date(2026, 3, 5))  # Mon–Thu

        # 0% — not started: early_start/early_finish/scheduled_start all equal
        # the full span (ADR-0752 table: not-started windows coincide).
        task = Task.objects.create(
            project=self.project,
            name="NotStarted",
            duration=4,
            early_start=full_span[0],
            early_finish=full_span[1],
            scheduled_start=full_span[0],
            percent_complete=0,
            status=TaskStatus.NOT_STARTED,
        )
        self._assign(task)
        hours_0pct = self._total_hours()
        assert hours_0pct == pytest.approx(32.0)  # 4 days × 8h × 1.0 units
        task.delete()

        # 50% — in progress, actual_start recorded: early_start has shrunk to
        # the remaining-work window (Wed–Thu per ADR-0132), but scheduled_start
        # still records the real span start (== actual_start, ADR-0752 §2).
        task = Task.objects.create(
            project=self.project,
            name="InProgress50",
            duration=4,
            early_start=date(2026, 3, 4),
            early_finish=full_span[1],
            scheduled_start=full_span[0],
            actual_start=full_span[0],
            percent_complete=50,
            status=TaskStatus.IN_PROGRESS,
        )
        self._assign(task)
        hours_50pct = self._total_hours()
        task.delete()

        # 100% — complete: ADR-0136 already pins early_start back to the full
        # span for completed tasks, so scheduled_start == early_start here too.
        task = Task.objects.create(
            project=self.project,
            name="Complete",
            duration=4,
            early_start=full_span[0],
            early_finish=full_span[1],
            scheduled_start=full_span[0],
            actual_start=full_span[0],
            actual_finish=full_span[1],
            percent_complete=100,
            status=TaskStatus.COMPLETE,
        )
        self._assign(task)
        hours_100pct = self._total_hours()
        task.delete()

        assert hours_50pct == pytest.approx(hours_0pct)
        assert hours_100pct == pytest.approx(hours_0pct)

    def test_in_progress_task_reproduces_bug_on_early_start_alone(self) -> None:
        """Direct repro: an in-progress task whose remaining window (early_start)
        has shrunk to a single day must still report its full elapsed+remaining
        span (4 days), not the 1 remaining day. This is the exact shape from the
        issue: a 4-day task at ~83% complete contributing 1 day instead of 4.
        """
        task = Task.objects.create(
            project=self.project,
            name="AlmostDone",
            duration=4,
            early_start=date(2026, 3, 5),  # remaining window: Thu only
            early_finish=date(2026, 3, 5),
            scheduled_start=date(2026, 3, 2),  # real span: Mon–Thu
            actual_start=date(2026, 3, 2),
            percent_complete=83,
            status=TaskStatus.IN_PROGRESS,
        )
        self._assign(task)

        hours = self._total_hours()

        assert hours == pytest.approx(32.0)  # 4 days, not 1
        resp = self.client.get(_url(self.project), {"start": "2026-03-02", "end": "2026-03-05"})
        days = resp.data["resources"][0]["days"]
        assert set(days) == {"2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"}

    def test_window_intersection_elapsed_load_still_counts(self) -> None:
        """A task whose remaining window has moved past the query range entirely
        must still contribute the elapsed portion of its load that falls inside
        that range — the span, not the remaining window, decides inclusion.
        """
        # Remaining window (early_start..early_finish) is Fri 3/6 only — outside
        # the Mon 3/2..Tue 3/3 query window below. The real span (scheduled_start)
        # starts Mon 3/2, so the elapsed Mon/Tue portion must still be counted.
        task = Task.objects.create(
            project=self.project,
            name="MostlyDone",
            duration=4,
            early_start=date(2026, 3, 6),
            early_finish=date(2026, 3, 6),
            scheduled_start=date(2026, 3, 2),
            actual_start=date(2026, 3, 2),
            percent_complete=90,
            status=TaskStatus.IN_PROGRESS,
        )
        self._assign(task)

        hours = self._total_hours(start="2026-03-02", end="2026-03-03")

        # Mon + Tue elapsed portion, clamped to the query window: 2 days × 8h.
        assert hours == pytest.approx(16.0)

    def test_unassigned_task_count_uses_span_too(self) -> None:
        """The unassigned-task counter windows on the same span, not the
        remaining-work window, so an unassigned in-progress task is not dropped
        from the count once its remaining window narrows past the query end.
        """
        Task.objects.create(
            project=self.project,
            name="UnassignedInProgress",
            duration=4,
            early_start=date(2026, 3, 6),  # remaining window outside the window below
            early_finish=date(2026, 3, 6),
            scheduled_start=date(2026, 3, 2),
            actual_start=date(2026, 3, 2),
            percent_complete=90,
            status=TaskStatus.IN_PROGRESS,
        )
        resp = self.client.get(_url(self.project), {"start": "2026-03-02", "end": "2026-03-03"})
        assert resp.status_code == 200
        assert resp.data["unassigned_task_count"] == 1

    def test_missing_scheduled_start_falls_back_to_early_start(self) -> None:
        """A task with no ``scheduled_start`` (e.g. not yet recalculated since the
        ADR-0752 migration) must still be windowed correctly, falling back to
        ``early_start`` — the pre-#2622 behavior — rather than being dropped."""
        task = Task.objects.create(
            project=self.project,
            name="NotYetRecalculated",
            duration=4,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 5),
            scheduled_start=None,
            percent_complete=0,
            status=TaskStatus.NOT_STARTED,
        )
        self._assign(task)

        hours = self._total_hours()
        assert hours == pytest.approx(32.0)


# ---------------------------------------------------------------------------
# Date window filtering
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationWindow:
    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="Std2", working_days=31, hours_per_day=8.0)
        self.project = Project.objects.create(
            name="WP", start_date=date(2026, 3, 2), calendar=self.cal
        )
        self.resource = Resource.objects.create(name="Ida", max_units="1.0")
        # Task: Mon Mar 2 – Fri Mar 13 (10 working days)
        self.task = Task.objects.create(
            project=self.project,
            name="T",
            duration=10,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 13),
        )
        TaskResource.objects.create(task=self.task, resource=self.resource, units="1.0")
        self.client = _auth_client(Role.SCHEDULER, self.project)

    def test_default_window_covers_full_task(self) -> None:
        resp = self.client.get(_url(self.project))
        assert resp.status_code == 200
        days = resp.data["resources"][0]["days"]
        assert "2026-03-02" in days
        assert "2026-03-13" in days

    def test_explicit_start_trims_early_days(self) -> None:
        resp = self.client.get(_url(self.project), {"start": "2026-03-09"})
        days = resp.data["resources"][0]["days"]
        assert "2026-03-02" not in days
        assert "2026-03-09" in days

    def test_explicit_end_trims_late_days(self) -> None:
        resp = self.client.get(_url(self.project), {"end": "2026-03-06"})
        days = resp.data["resources"][0]["days"]
        assert "2026-03-13" not in days
        assert "2026-03-06" in days

    def test_invalid_start_date_returns_400(self) -> None:
        resp = self.client.get(_url(self.project), {"start": "not-a-date"})
        assert resp.status_code == 400

    def test_start_after_end_returns_400(self) -> None:
        resp = self.client.get(_url(self.project), {"start": "2026-03-13", "end": "2026-03-02"})
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Pure-function boundary coverage (#4266 mutation-testing baseline).
#
# These hit the private helpers directly rather than through the endpoint:
# they're calendar/band boundary conditions that are cheap to express as a
# single value-in, value-out check and expensive to manufacture through a
# full request/response round trip for every edge.
# ---------------------------------------------------------------------------


class TestLoadBandBoundaries:
    """Mirrors resourceUtils.loadColor (web rule 91) at its exact edges."""

    def test_just_over_100_is_critical_not_at_risk(self) -> None:
        assert _load_band(100.5) == "critical"

    def test_exactly_85_is_at_risk_not_on_track(self) -> None:
        assert _load_band(85.0) == "at-risk"

    def test_just_under_85_is_on_track(self) -> None:
        assert _load_band(84.9) == "on-track"


class TestFirstWorkingDayInBoundaries:
    def test_a_single_working_day_span_finds_itself(self) -> None:
        """start == end, both the same working day: must not read as empty."""
        d = date(2026, 3, 2)  # Monday
        assert _first_working_day_in(_MON_FRI, [], d, d) == d

    def test_scans_day_by_day_not_in_steps_of_two(self) -> None:
        """Sunday 2026-03-01 -> Monday 2026-03-02 is the first working day, not
        Tuesday 2026-03-03 (which a stride of 2 would land on instead)."""
        start = date(2026, 3, 1)  # Sunday
        end = date(2026, 3, 5)  # Thursday
        assert _first_working_day_in(_MON_FRI, [], start, end) == date(2026, 3, 2)


class TestPartitionAllocationsBoundaries:
    def test_a_single_day_span_start_equals_end_is_dated_not_baseline(self) -> None:
        """end == start is a valid one-day commitment, not a reversed/undated one."""
        d = date(2026, 3, 2)
        baseline, dated = _partition_allocations([_alloc("1.0", d, d)])
        assert baseline == Decimal("0")
        assert dated == [(Decimal("1.0"), d, d)]

    def test_only_one_side_undated_is_still_a_baseline_commitment(self) -> None:
        """``or`` means ANY missing endpoint makes a span undated — a caller
        could in principle set only one of ``start``/``end`` (an ``and`` here
        would instead require BOTH missing, and then fall through to comparing
        a real date against ``None``, which raises rather than classifying the
        allocation at all)."""
        d = date(2026, 3, 2)
        baseline, dated = _partition_allocations([_alloc("1.0", None, d)])
        assert baseline == Decimal("1.0")
        assert dated == []


class TestCountWorkingDaysInRangeBoundary:
    def test_single_day_range_on_a_working_day_counts_one(self) -> None:
        d = date(2026, 3, 2)  # Monday
        assert _count_working_days_in_range(_MON_FRI, [], d, d) == 1


class TestAccumulateDaysDirectly:
    """``_accumulate_days`` is pure dict bookkeeping — test it without a DB.

    ``days`` must be the same ``defaultdict(lambda: {"hours": 0.0, "tasks": []})``
    shape the real engine passes in (see ``_init_resource_row``); a plain dict
    KeyErrors on the first write.
    """

    def _days(self) -> defaultdict:
        return defaultdict(lambda: {"hours": 0.0, "tasks": []})

    def test_hours_round_to_four_decimals_not_five(self) -> None:
        days = self._days()
        d = date(2026, 3, 2)  # Monday
        _accumulate_days(days, d, d, _MON_FRI, [], 0.123456, "task-a")
        assert days[d.isoformat()]["hours"] == 0.1235

    def test_task_pk_is_the_real_value_not_a_placeholder(self) -> None:
        days = self._days()
        d = date(2026, 3, 2)
        _accumulate_days(days, d, d, _MON_FRI, [], 1.0, "task-real-pk")
        assert days[d.isoformat()]["tasks"] == ["task-real-pk"]


class TestResourceColorDirectly:
    """``_resource_color`` hashes the first 8 hex chars of ``resource_id`` (dashes
    stripped) in base 16, mod the 12-entry avatar palette.

    The dash-stripping call itself (``.replace("-", "")``) is NOT targeted here —
    it is a proven-equivalent mutant for any standard, hyphenated UUID: the first
    dash in ``8-4-4-4-12`` form always falls at index 8, so the ``[:8]`` slice
    this function takes is pure hex whether or not dashes are stripped first, or
    stripped to a different replacement. See the #4266 MR description.
    """

    def test_color_is_not_a_constant_regardless_of_input(self) -> None:
        # Freezing the hash to a constant (e.g. 16) would map every resource to
        # the SAME palette entry (16 % 12 == 4) regardless of its own id.
        a = _resource_color("00000000-0000-0000-0000-000000000000")
        b = _resource_color("abcdef12-0000-0000-0000-000000000000")
        assert a != b

    def test_color_reads_exactly_the_first_eight_hex_characters(self) -> None:
        rid = "0000000a-ffff-ffff-ffff-ffffffffffff"
        expected = _AVATAR_COLORS[int("0000000a", 16) % len(_AVATAR_COLORS)]
        assert _resource_color(rid) == expected

    def test_color_hashes_in_base_sixteen_not_seventeen(self) -> None:
        rid = "12345678-0000-0000-0000-000000000000"
        expected = _AVATAR_COLORS[int("12345678", 16) % len(_AVATAR_COLORS)]
        assert _resource_color(rid) == expected


class TestInitialsDirectly:
    """``_initials`` — first+last initial for 2+ words, else a prefix of the
    single word, uppercased throughout.
    """

    def test_two_words_use_first_and_last_initial(self) -> None:
        assert _initials("John Smith") == "JS"

    def test_three_words_use_the_first_and_the_last_not_the_middle(self) -> None:
        """Distinguishes every off-by-one index variant on the >=2-words branch:
        a wrong index (parts[1], parts[0][1], parts[+1], parts[-2], parts[-1][1])
        each lands on a DIFFERENT letter than "J" or "S" for this fixture."""
        assert _initials("John Middle Smith") == "JS"

    def test_single_multi_char_word_is_its_own_first_two_chars(self) -> None:
        assert _initials("Alexander") == "AL"

    def test_single_character_name_uppercases_rather_than_lowercases(self) -> None:
        assert _initials("a") == "A"


class TestSumWeekHoursDirectly:
    def test_sums_across_multiple_present_days_in_range(self) -> None:
        """Three present days must ACCUMULATE, not overwrite or stride past one."""
        days = {
            "2026-03-02": {"hours": 1.0, "tasks": []},
            "2026-03-03": {"hours": 2.0, "tasks": []},
            "2026-03-04": {"hours": 4.0, "tasks": []},
        }
        total = _sum_week_hours(days, date(2026, 3, 2), date(2026, 3, 4))
        assert total == 7.0

    def test_single_day_range_counts_that_day_once(self) -> None:
        """wstart == wend is a valid one-day week slice, not an empty range."""
        days = {"2026-03-02": {"hours": 9.0, "tasks": []}}
        total = _sum_week_hours(days, date(2026, 3, 2), date(2026, 3, 2))
        assert total == 9.0


class TestWeeklyUtilForResourceDirectly:
    """``_weekly_util_for_resource`` — util% = 100 x hours / (hrs x units x
    working_days), clamped to 0 when there is no capacity to divide by.
    """

    def _row(self, hrs: float, max_units: str, mask: int, days: dict) -> dict:
        return {
            "hours_per_day": hrs,
            "max_units": max_units,
            "_mask": mask,
            "_exc_ranges": [],
            "_days": days,
        }

    def test_util_pct_is_the_documented_ratio_not_a_different_operator(self) -> None:
        """hrs=1, max_units=2 (NOT 1 — a 1.0 multiplier would make `*` and `/`
        on max_units coincide), Mon-Wed calendar (3 working days) -> capacity
        1 x 2 x 3 = 6. 2.0 hours of load against that gives a repeating-decimal
        ratio (33.33%) that a x100-vs-x101 multiplier, or a *-vs-/ on
        working_days/max_units, each round to a visibly different integer."""
        row = self._row(1.0, "2.0", 7, {"2026-03-02": {"hours": 2.0, "tasks": []}})  # Mon
        week_dates = [(date(2026, 3, 2), date(2026, 3, 8))]  # Mon..Sun
        assert _weekly_util_for_resource(row, week_dates) == [33]

    def test_zero_working_days_reads_as_zero_not_undefined_or_a_crash(self) -> None:
        """A calendar with no working day at all in the week (mask=0) makes
        capacity 0 — the ratio is clamped to 0, not computed as if capacity
        were positive (which would ZeroDivisionError)."""
        row = self._row(8.0, "1.0", 0, {})
        week_dates = [(date(2026, 3, 2), date(2026, 3, 8))]
        assert _weekly_util_for_resource(row, week_dates) == [0]

    def test_fractional_capacity_below_one_is_not_treated_as_zero(self) -> None:
        """capacity = 0.5 x 1 working day = 0.5 — strictly between 0 and 1, so
        the `> 0` guard (not `> 1`) must still take the real-ratio branch."""
        row = self._row(0.5, "1.0", 1, {"2026-03-02": {"hours": 0.25, "tasks": []}})  # Mon only
        week_dates = [(date(2026, 3, 2), date(2026, 3, 8))]
        assert _weekly_util_for_resource(row, week_dates) == [50]


@pytest.mark.django_db
class TestAggregateUtilizationWeeklyDirectly:
    """``aggregate_utilization_weekly`` — the weekly heat map's own aggregation,
    exercised directly (not through the heatmap endpoint, which the e2e-adjacent
    tests above already cover for shape) so each week-boundary and sort-order
    case stays a single, cheap, DB-backed call.
    """

    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="Std", working_days=31, hours_per_day=8.0)
        self.project = Project.objects.create(
            name="AggP", start_date=date(2026, 3, 2), calendar=self.cal
        )

    def test_default_group_by_is_none_and_is_echoed_back(self) -> None:
        result = aggregate_utilization_weekly(self.project, date(2026, 3, 2), 1)
        assert result["group_by"] == "none"

    def test_week_label_is_the_real_iso_year_and_week_not_a_different_code(self) -> None:
        wstart = date(2026, 3, 2)
        result = aggregate_utilization_weekly(self.project, wstart, 1)
        assert result["weeks"] == [f"{wstart.strftime('%G')}-W{wstart.strftime('%V')}"]

    def test_week_spans_exactly_its_own_monday_through_sunday(self) -> None:
        """A 1-unit/day-all-week calendar (every day working) with load ONLY on
        the week's own Sunday, and a second task on the FOLLOWING Monday that
        must NOT be pulled in. A wrong week-end (wstart-6 or wstart+7) either
        drops the Sunday load entirely or leaks in the next week's Monday."""
        all_days_cal = Calendar.objects.create(name="AllDays", working_days=127, hours_per_day=8.0)
        project = Project.objects.create(
            name="SevenDay", start_date=date(2026, 3, 2), calendar=all_days_cal
        )
        resource = Resource.objects.create(name="Carol", max_units="1.0")
        sunday = date(2026, 3, 8)
        next_monday = date(2026, 3, 9)
        sun_task = Task.objects.create(
            project=project, name="Sun", duration=1, early_start=sunday, early_finish=sunday
        )
        TaskResource.objects.create(task=sun_task, resource=resource, units="1.0")
        leak_task = Task.objects.create(
            project=project,
            name="NextMon",
            duration=1,
            early_start=next_monday,
            early_finish=next_monday,
        )
        TaskResource.objects.create(task=leak_task, resource=resource, units="1.0")

        result = aggregate_utilization_weekly(project, date(2026, 3, 2), 1)
        assert len(result["resources"]) == 1
        # capacity = 8h/day x 1.0 units x 7 working days = 56h; load = Sunday's
        # 8h only = 8h -> round(100 x 8 / 56) = 14.
        assert result["resources"][0]["util"] == [14]

    def test_window_end_follows_the_last_week_not_an_off_by_one_week(self) -> None:
        """3-week window with load ONLY in the third (last) week. A window_end
        pinned to an earlier week's end would exclude this task from the daily
        engine's query entirely, dropping the resource from the response."""
        resource = Resource.objects.create(name="Dave", max_units="1.0")
        week3_monday = date(2026, 3, 2) + timedelta(weeks=2)
        week3_friday = week3_monday + timedelta(days=4)
        task = Task.objects.create(
            project=self.project,
            name="LateWork",
            duration=5,
            early_start=week3_monday,
            early_finish=week3_friday,
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        result = aggregate_utilization_weekly(self.project, date(2026, 3, 2), 3)
        assert len(result["resources"]) == 1
        assert result["resources"][0]["util"] == [0, 0, 100]

    def test_full_resource_row_shape_matches_the_documented_contract(self) -> None:
        resource = Resource.objects.create(name="Erin Shaper", max_units="1.0", job_role="Engineer")
        own_cal = Calendar.objects.create(name="Own", working_days=31, hours_per_day=8.0)
        resource.calendar = own_cal
        resource.save()
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        result = aggregate_utilization_weekly(self.project, date(2026, 3, 2), 1)
        row = result["resources"][0]
        assert row["id"] == str(resource.pk)
        assert row["name"] == "Erin Shaper"
        assert row["initials"] == "ES"
        assert row["job_role"] == "Engineer"
        assert row["color"] == _resource_color(str(resource.pk))
        # The resource's own calendar is a DIFFERENT row than the project's.
        assert row["calendar_differs_from_project"] is True
        # One 8h day against a 5-working-day (Mon-Fri), 8h/day, 1.0-unit week:
        # round(100 x 8 / (8 x 1.0 x 5)) = 20.
        assert row["util"] == [20]

    def test_group_by_role_sorts_by_job_role_then_name(self) -> None:
        a = Resource.objects.create(name="Zed", max_units="1.0", job_role="Analyst")
        b = Resource.objects.create(name="Amy", max_units="1.0", job_role="Builder")
        for r in (a, b):
            task = Task.objects.create(
                project=self.project,
                name=f"T-{r.name}",
                duration=1,
                early_start=date(2026, 3, 2),
                early_finish=date(2026, 3, 2),
            )
            TaskResource.objects.create(task=task, resource=r, units="1.0")

        result = aggregate_utilization_weekly(self.project, date(2026, 3, 2), 1, group_by="role")
        assert result["group_by"] == "role"
        # Analyst (Zed) sorts before Builder (Amy) by job_role, NOT by name.
        assert [row["name"] for row in result["resources"]] == ["Zed", "Amy"]

    def test_group_by_none_sorts_by_name_not_job_role(self) -> None:
        a = Resource.objects.create(name="Zed", max_units="1.0", job_role="Analyst")
        b = Resource.objects.create(name="Amy", max_units="1.0", job_role="Builder")
        for r in (a, b):
            task = Task.objects.create(
                project=self.project,
                name=f"T-{r.name}",
                duration=1,
                early_start=date(2026, 3, 2),
                early_finish=date(2026, 3, 2),
            )
            TaskResource.objects.create(task=task, resource=r, units="1.0")

        result = aggregate_utilization_weekly(self.project, date(2026, 3, 2), 1)
        assert result["group_by"] == "none"
        assert [row["name"] for row in result["resources"]] == ["Amy", "Zed"]


# ---------------------------------------------------------------------------
# #989 — server-owned per-day load% + band + overallocation verdict
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationLoadVerdict:
    """The server returns the same load%/band/overallocated verdict the heatmap's
    ``u > 100`` check and resourceUtils.loadColor (web rule 91) produced, so a
    headless/MCP client reads it instead of re-deriving from raw hours (#989)."""

    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="StdV", working_days=31, hours_per_day=8.0)
        self.project = Project.objects.create(
            name="PV", start_date=date(2026, 3, 2), calendar=self.cal
        )

    def _day(self, units: str, max_units: str = "1.0", n_tasks: int = 1) -> dict:
        resource = Resource.objects.create(name="R", max_units=max_units)
        for i in range(n_tasks):
            task = Task.objects.create(
                project=self.project,
                name=f"T{i}",
                duration=1,
                early_start=date(2026, 3, 2),
                early_finish=date(2026, 3, 2),
            )
            TaskResource.objects.create(task=task, resource=resource, units=units)
        resp = _auth_client(Role.SCHEDULER, self.project).get(_url(self.project))
        assert resp.status_code == 200
        return resp.data["resources"][0]

    def test_below_85_is_on_track(self) -> None:
        """0.5 units → 4h / 8h = 50% → on-track, not overallocated."""
        res = self._day(units="0.5")
        day = res["days"]["2026-03-02"]
        assert day["load_pct"] == pytest.approx(50.0)
        assert day["load_band"] == "on-track"
        assert day["overallocated"] is False
        assert res["overallocated"] is False

    def test_full_allocation_is_at_risk_not_overallocated(self) -> None:
        """Exactly 100% load is at-risk; >100 (not ==100) is the overallocation line."""
        res = self._day(units="1.0")
        day = res["days"]["2026-03-02"]
        assert day["load_pct"] == pytest.approx(100.0)
        assert day["load_band"] == "at-risk"
        assert day["overallocated"] is False
        assert res["overallocated"] is False

    def test_over_100_is_critical_and_overallocated(self) -> None:
        """Two 1.0-unit tasks on a 1.0-unit resource → 200% → critical + overallocated,
        and the resource-level overallocated flag flips true."""
        res = self._day(units="1.0", n_tasks=2)
        day = res["days"]["2026-03-02"]
        assert day["load_pct"] == pytest.approx(200.0)
        assert day["load_band"] == "critical"
        assert day["overallocated"] is True
        assert res["overallocated"] is True


# ---------------------------------------------------------------------------
# peak_concurrent_units — the write-time overallocation verdict (#3534)
#
# Pure function, no DB: the arithmetic the write-time warning compares against
# Resource.max_units. Mon-Fri mask (31) matches Calendar's own default.
# ---------------------------------------------------------------------------

_MON_FRI = 31


def _alloc(units: str, start: date | None = None, end: date | None = None) -> Allocation:
    return Allocation(units=Decimal(units), start=start, end=end)


class TestPeakConcurrentUnits:
    """Peak load on one working day — not a project-lifetime sum."""

    def test_non_overlapping_spans_peak_at_one_task(self) -> None:
        """Three 0.8-unit tasks with no shared day peak at 0.8, not 2.4 (#3534)."""
        peak, day = peak_concurrent_units(
            [
                _alloc("0.8", date(2026, 9, 7), date(2026, 9, 14)),
                _alloc("0.8", date(2026, 10, 13), date(2026, 10, 16)),
                _alloc("0.8", date(2026, 11, 6), date(2026, 11, 9)),
            ],
            _MON_FRI,
            [],
        )
        assert peak == Decimal("0.8")
        assert day == date(2026, 9, 7)

    def test_three_way_overlap_sums(self) -> None:
        """The peak needs no pairwise assumption — three spans stack on one day."""
        peak, day = peak_concurrent_units(
            [
                _alloc("0.4", date(2026, 9, 7), date(2026, 9, 30)),
                _alloc("0.4", date(2026, 9, 9), date(2026, 9, 30)),
                _alloc("0.4", date(2026, 9, 11), date(2026, 9, 30)),
            ],
            _MON_FRI,
            [],
        )
        assert peak == Decimal("1.2")
        assert day == date(2026, 9, 11)

    def test_weekend_only_overlap_is_not_a_peak(self) -> None:
        """2026-04-04 is a Saturday and the only shared day — no working-day conflict."""
        peak, _day = peak_concurrent_units(
            [
                _alloc("0.6", date(2026, 4, 1), date(2026, 4, 4)),
                _alloc("0.6", date(2026, 4, 4), date(2026, 4, 10)),
            ],
            _MON_FRI,
            [],
        )
        assert peak == Decimal("0.6")

    def test_calendar_exception_removes_the_overlap(self) -> None:
        """A shutdown range covering the only shared working day clears the peak."""
        spans = [
            _alloc("0.6", date(2026, 4, 1), date(2026, 4, 6)),
            _alloc("0.6", date(2026, 4, 6), date(2026, 4, 10)),
        ]
        peak_without, _ = peak_concurrent_units(spans, _MON_FRI, [])
        assert peak_without == Decimal("1.2")  # both cover Mon 2026-04-06
        peak_with, _ = peak_concurrent_units(
            spans, _MON_FRI, [(date(2026, 4, 6), date(2026, 4, 6))]
        )
        assert peak_with == Decimal("0.6")

    def test_undated_allocations_apply_to_every_day(self) -> None:
        """An unscheduled task has no span to exonerate it, so it is a floor."""
        peak, day = peak_concurrent_units(
            [
                _alloc("0.5"),
                _alloc("0.5", date(2026, 9, 7), date(2026, 9, 14)),
            ],
            _MON_FRI,
            [],
        )
        assert peak == Decimal("1.0")
        assert day == date(2026, 9, 7)

    def test_all_undated_returns_a_floor_with_no_day(self) -> None:
        peak, day = peak_concurrent_units([_alloc("0.5"), _alloc("0.8")], _MON_FRI, [])
        assert peak == Decimal("1.3")
        assert day is None

    def test_empty_is_zero(self) -> None:
        assert peak_concurrent_units([], _MON_FRI, []) == (Decimal("0"), None)

    def test_degenerate_calendar_falls_back_to_raw_span_starts(self) -> None:
        """No working day anywhere must not silently report a genuine overlap as zero.

        A mask of 0 is rejected by the model validator, but a calendar whose
        exceptions blanket the spans reaches the same state — and reporting the
        peak as the undated floor there would disarm the warning entirely.
        """
        peak, day = peak_concurrent_units(
            [
                _alloc("0.6", date(2026, 4, 6), date(2026, 4, 10)),
                _alloc("0.6", date(2026, 4, 6), date(2026, 4, 10)),
            ],
            _MON_FRI,
            [(date(2026, 4, 1), date(2026, 4, 30))],
        )
        assert peak == Decimal("1.2")
        assert day == date(2026, 4, 6)

    def test_reversed_span_is_treated_as_undated(self) -> None:
        """A finish before its start is not a window; count it rather than drop it."""
        peak, day = peak_concurrent_units(
            [_alloc("1.5", date(2026, 9, 14), date(2026, 9, 7))], _MON_FRI, []
        )
        assert peak == Decimal("1.5")
        assert day is None

    def test_sweep_opens_in_start_order_not_insertion_or_unit_order(self) -> None:
        """The three spans are passed smallest-units-first; `by_start` must sort by
        each span's OWN start date, not by the tuple's (units, start, end) order a
        broken sort key would fall back to. Under that fallback, B's own start
        (2026-03-02, the earliest) is sorted last among the three — so by the time
        the sweep reaches 2026-03-02 it does not open B yet, and the peak it finds
        is lower and on the wrong day entirely."""
        peak, day = peak_concurrent_units(
            [
                _alloc("0.1", date(2026, 3, 9), date(2026, 3, 27)),  # "A"
                _alloc("0.9", date(2026, 3, 2), date(2026, 3, 6)),  # "B" — earliest start
                _alloc("0.5", date(2026, 3, 16), date(2026, 3, 20)),  # "C"
            ],
            _MON_FRI,
            [],
        )
        assert peak == Decimal("0.9")
        assert day == date(2026, 3, 2)

    def test_sweep_closes_in_end_order_not_start_order(self) -> None:
        """Same shape as above, but exercised against `by_end`: X opens first and
        runs long, Y opens next and closes almost immediately, Z opens last on a
        single day. The true peak (X+Y, both open) lands on Y's own start day; a
        `by_end` sorted by each span's START instead of its END closes Y a day
        late, so the peak is found (with the same total, by coincidence) on the
        wrong day."""
        peak, day = peak_concurrent_units(
            [
                _alloc("1.0", date(2026, 3, 2), date(2026, 3, 20)),  # "X"
                _alloc("1.0", date(2026, 3, 3), date(2026, 3, 4)),  # "Y"
                _alloc("1.0", date(2026, 3, 5), date(2026, 3, 5)),  # "Z"
            ],
            _MON_FRI,
            [],
        )
        assert peak == Decimal("2")
        assert day == date(2026, 3, 3)

    def test_closing_an_allocation_subtracts_its_own_units_only(self) -> None:
        """D2 closes while D1 (still open) and D3 (freshly opened) both remain —
        the running total after closing D2 must be D1+D3, not D2's own units
        overwriting whatever was running (which would silently lose the others'
        contribution and under-report the real peak)."""
        peak, day = peak_concurrent_units(
            [
                _alloc("0.5", date(2026, 3, 2), date(2026, 3, 20)),  # D1 — long-running
                _alloc("0.3", date(2026, 3, 2), date(2026, 3, 6)),  # D2 — closes early
                _alloc("0.6", date(2026, 3, 9), date(2026, 3, 13)),  # D3 — opens after
            ],
            _MON_FRI,
            [],
        )
        assert peak == Decimal("1.1")
        assert day == date(2026, 3, 9)

    def test_a_zero_unit_dated_span_never_exceeds_the_baseline(self) -> None:
        """`dated` is non-empty but contributes nothing, so the candidate sweep
        never updates `peak_day` past its initial value — which must read back as
        None (no day to report), not an empty-string placeholder."""
        peak, day = peak_concurrent_units(
            [_alloc("0", date(2026, 3, 2), date(2026, 3, 2))], _MON_FRI, []
        )
        assert peak == Decimal("0")
        assert day is None


# ---------------------------------------------------------------------------
# Perf contract (#3576): unassigned_task_count is a NOT EXISTS, not a literal
# NOT IN built from the day expansion
# ---------------------------------------------------------------------------


def _seed_utilization(project: Project, resources: int, tasks_per_resource: int = 2) -> None:
    for r in range(resources):
        resource = Resource.objects.create(
            name=f"U{r:03d}", email=f"u{r:03d}@example.com", max_units=Decimal("1.00")
        )
        for t in range(tasks_per_resource):
            task = Task.objects.create(
                project=project,
                name=f"T{r:03d}-{t}",
                duration=5,
                early_start=date(2026, 3, 2),
                early_finish=date(2026, 3, 6),
                status=TaskStatus.NOT_STARTED,
            )
            TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.50"))


@pytest.mark.django_db
class TestUtilizationQueryBudget:
    def test_query_count_is_flat_in_the_number_of_resources(self, project: Project) -> None:
        """The read cost must not grow with the number of assignment rows.

        Moves the number of underlying ROWS, not a page size — two requests at
        different ``?page_size=`` values are the same request and prove nothing.
        """
        client = _auth_client(Role.SCHEDULER, project)
        window = {"start": "2026-03-02", "end": "2026-03-06"}

        _seed_utilization(project, resources=1)
        assert client.get(_url(project), window).status_code == 200  # warm caches

        with CaptureQueriesContext(connection) as small:
            small_body = client.get(_url(project), window).json()

        _seed_utilization(project, resources=10)
        with CaptureQueriesContext(connection) as large:
            large_body = client.get(_url(project), window).json()

        # Not vacuous: the second request really did compute ten times the load.
        assert len(small_body["resources"]) == 1
        assert len(large_body["resources"]) == 11

        assert len(large.captured_queries) == len(small.captured_queries), (
            f"{len(small.captured_queries)} → {len(large.captured_queries)}"
        )

    def test_unassigned_count_uses_not_exists_not_a_literal_not_in(self, project: Project) -> None:
        """The counting statement must not carry an inlined UUID list.

        The old form shipped one UUID of SQL text per in-window task and was O(N)
        per candidate row. Asserted on the emitted SQL: a `NOT IN (` in the
        statement that counts tasks is the defect, and a growing statement length
        is its fingerprint.
        """
        client = _auth_client(Role.SCHEDULER, project)
        window = {"start": "2026-03-02", "end": "2026-03-06"}

        _seed_utilization(project, resources=6, tasks_per_resource=4)  # 24 assigned tasks

        with CaptureQueriesContext(connection) as ctx:
            assert client.get(_url(project), window).status_code == 200

        counts = [
            q["sql"]
            for q in ctx.captured_queries
            if q["sql"].startswith("SELECT COUNT(") and "projects_task" in q["sql"]
        ]
        assert counts, "no statement counted tasks"
        for sql in counts:
            assert "NOT IN (" not in sql, sql
        assert any("NOT EXISTS" in sql for sql in counts), counts

    def test_a_task_whose_span_has_no_working_day_still_counts_as_assigned(
        self, project: Project
    ) -> None:
        """Regression: the count answers "has no assignment", not "produced load".

        The old implementation derived its assigned-set from the per-day
        expansion, so a task whose span falls entirely on non-working days was
        reported as *unassigned* despite carrying an assignment.
        """
        client = _auth_client(Role.SCHEDULER, project)
        resource = Resource.objects.create(
            name="Weekender", email="w@example.com", max_units=Decimal("1.00")
        )
        # 2026-03-07 / 03-08 are Saturday and Sunday under the Mon–Fri calendar.
        weekend_task = Task.objects.create(
            project=project,
            name="WeekendOnly",
            duration=2,
            early_start=date(2026, 3, 7),
            early_finish=date(2026, 3, 8),
            status=TaskStatus.NOT_STARTED,
        )
        TaskResource.objects.create(task=weekend_task, resource=resource, units=Decimal("1.00"))

        body = client.get(_url(project), {"start": "2026-03-07", "end": "2026-03-08"}).json()

        # It produced no load — the span holds no working day, so the per-day
        # expansion the old count read its set from is empty …
        assert all(row["days"] == {} for row in body["resources"])
        # … but the task plainly has an assignment, so it is not unassigned.
        assert body["unassigned_task_count"] == 0


# ---------------------------------------------------------------------------
# #3574 — ProjectResource.units_override is a PER-PROJECT capacity statement,
# so the daily engine must apply it. Before this, the Overview card honored the
# override and every other read used Resource.max_units, so a person rostered at
# 0.5 and assigned 0.5 read 100% on the card and 50% one click away.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDailyEngineHonorsUnitsOverride:
    def _roster(
        self,
        project: Project,
        cal: Calendar,
        *,
        max_units: str,
        units_override: str | None,
        name: str = "Ada",
    ) -> Resource:
        resource = Resource.objects.create(name=name, calendar=cal, max_units=Decimal(max_units))
        ProjectResource.objects.create(
            project=project,
            resource=resource,
            units_override=(Decimal(units_override) if units_override is not None else None),
        )
        return resource

    def _one_day(self, project: Project, resource: Resource, units: str) -> None:
        # Mon 2026-03-02, one working day, so the day's load is unambiguous.
        task = Task.objects.create(
            project=project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
            status=TaskStatus.NOT_STARTED,
            wbs_path="1",
        )
        TaskResource.objects.create(task=task, resource=resource, units=Decimal(units))

    def _day(self, project: Project) -> dict[str, object]:
        c = _auth_client(Role.SCHEDULER, project)
        resp = c.get(_url(project), {"start": "2026-03-02", "end": "2026-03-02"})
        assert resp.status_code == 200
        row = resp.data["resources"][0]
        return {"row": row, "day": row["days"]["2026-03-02"]}

    def test_half_time_roster_reads_100_percent_not_50(
        self, project: Project, cal: Calendar
    ) -> None:
        """The bug, stated directly: 0.5 assigned against a 0.5 roster slot is full."""
        resource = self._roster(project, cal, max_units="1.0", units_override="0.5")
        self._one_day(project, resource, "0.5")
        out = self._day(project)
        assert out["day"]["load_pct"] == 100.0
        assert out["day"]["load_band"] == "at-risk"
        assert out["day"]["overallocated"] is False
        # The published capacity is the per-project one, so the client's own bar
        # (hours / (hours_per_day x max_units)) cannot disagree with load_pct.
        assert out["row"]["max_units"] == "0.50"

    def test_half_time_roster_over_capacity_is_flagged(
        self, project: Project, cal: Calendar
    ) -> None:
        resource = self._roster(project, cal, max_units="1.0", units_override="0.5")
        self._one_day(project, resource, "0.6")
        out = self._day(project)
        assert out["day"]["load_pct"] == 120.0
        assert out["day"]["load_band"] == "critical"
        assert out["day"]["overallocated"] is True
        assert out["row"]["overallocated"] is True

    def test_no_override_still_uses_the_resource_default(
        self, project: Project, cal: Calendar
    ) -> None:
        """The negative control: without an override nothing about the read changes."""
        resource = self._roster(project, cal, max_units="1.0", units_override=None)
        self._one_day(project, resource, "0.5")
        out = self._day(project)
        assert out["day"]["load_pct"] == 50.0
        assert out["row"]["max_units"] == "1.00"

    def test_an_override_above_the_default_widens_capacity(
        self, project: Project, cal: Calendar
    ) -> None:
        """The override is the capacity, not a cap on it — 1.5 means 1.5."""
        resource = self._roster(project, cal, max_units="1.0", units_override="1.5")
        self._one_day(project, resource, "1.5")
        out = self._day(project)
        assert out["day"]["load_pct"] == 100.0
        assert out["row"]["max_units"] == "1.50"

    def test_zero_override_is_not_treated_as_unset(self, project: Project, cal: Calendar) -> None:
        """0 is a legitimate stored value: rostered here, holding no capacity here.

        A truthiness fallback (``units_override or max_units``) would silently
        promote it back to full time, which is the inverse of what it says.
        """
        resource = self._roster(project, cal, max_units="1.0", units_override="0")
        self._one_day(project, resource, "0.5")
        out = self._day(project)
        assert out["row"]["max_units"] == "0.00"
        # Zero capacity makes the ratio undefined; the engine's divide-by-zero guard
        # reports 0.0 rather than raising. The point of the assertion is the line
        # above: the 0 was not read as "no override set".
        assert out["day"]["load_pct"] == 0.0

    def test_assignee_without_a_roster_row_keeps_the_resource_default(
        self, project: Project, cal: Calendar
    ) -> None:
        """TaskResource does not require a ProjectResource; that person's capacity
        is their own default, and the engine must not invent an override for them."""
        resource = Resource.objects.create(
            name="Off Roster", calendar=cal, max_units=Decimal("1.0")
        )
        self._one_day(project, resource, "0.5")
        out = self._day(project)
        assert out["row"]["max_units"] == "1.00"
        assert out["day"]["load_pct"] == 50.0

    def test_an_override_on_another_project_does_not_leak(
        self, project: Project, cal: Calendar
    ) -> None:
        """A per-project override is scoped to its project — the roster lookup is
        keyed on (project, resource), so a sibling project's slot cannot bleed in."""
        other = Project.objects.create(name="Other", start_date=date(2026, 3, 2), calendar=cal)
        resource = Resource.objects.create(name="Shared", calendar=cal, max_units=Decimal("1.0"))
        ProjectResource.objects.create(
            project=other, resource=resource, units_override=Decimal("0.25")
        )
        self._one_day(project, resource, "0.5")
        out = self._day(project)
        assert out["row"]["max_units"] == "1.00"
        assert out["day"]["load_pct"] == 50.0

    def test_a_soft_deleted_roster_row_is_ignored(self, project: Project, cal: Calendar) -> None:
        resource = Resource.objects.create(name="Removed", calendar=cal, max_units=Decimal("1.0"))
        ProjectResource.objects.create(
            project=project,
            resource=resource,
            units_override=Decimal("0.5"),
            is_deleted=True,
        )
        self._one_day(project, resource, "0.5")
        out = self._day(project)
        assert out["row"]["max_units"] == "1.00"
