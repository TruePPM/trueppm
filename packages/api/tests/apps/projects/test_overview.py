"""Tests for the project overview API endpoints (issue #99).

Covers:
  GET /api/v1/projects/<pk>/overview/
  GET /api/v1/projects/<pk>/attention/
  GET /api/v1/projects/<pk>/my-tasks/
"""

from __future__ import annotations

import datetime
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="other", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def anon_client() -> APIClient:
    return APIClient()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Alpha",
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
    )


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def make_task(project: Project, **kwargs: object) -> Task:
    """Create a Task with sane defaults for overview tests."""
    defaults: dict[str, object] = {
        "name": "Task",
        "duration": 5,
    }
    defaults.update(kwargs)
    return Task.objects.create(project=project, **defaults)


# ---------------------------------------------------------------------------
# GET /api/v1/projects/<pk>/overview/
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProjectOverview:
    def url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/overview/"

    def test_unauthenticated_returns_401(
        self, anon_client: APIClient, project: Project, membership: object
    ) -> None:
        res = anon_client.get(self.url(project.pk))
        assert res.status_code == 401

    def test_non_member_returns_403(
        self, other_user: object, project: Project, membership: object
    ) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.get(self.url(project.pk))
        assert res.status_code == 403

    def test_unknown_project_returns_404(self, client: APIClient, membership: object) -> None:
        import uuid

        res = client.get(self.url(uuid.uuid4()))
        assert res.status_code == 404

    def test_empty_project_returns_unknown_health(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        res = client.get(self.url(project.pk))
        assert res.status_code == 200
        data = res.json()
        assert data["schedule_health"] == "unknown"
        assert data["spi"] is None
        assert data["tasks_late_count"] == 0
        assert data["critical_task_count"] == 0
        assert data["next_milestone"] is None
        # No roster → the ratio is undefined, and the endpoint names the cause so
        # the card can explain the blank instead of showing a bare em-dash (#2428).
        assert data["team_utilization_pct"] is None
        assert data["team_utilization_reason"] == "no_roster"
        # Risk summary fields are always present (zero when no open risks).
        assert data["open_risk_count"] == 0
        assert data["high_risk_count"] == 0

    def test_owner_name_returned_when_owner_member_exists(
        self, client: APIClient, project: Project, user: object, membership: object
    ) -> None:
        res = client.get(self.url(project.pk))
        assert res.status_code == 200
        data = res.json()
        # The user fixture creates user with username="pm"; membership is OWNER
        assert data["owner_name"] is not None
        assert "owner_name" in data

    def test_start_date_returned_in_iso_format(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        res = client.get(self.url(project.pk))
        assert res.status_code == 200
        data = res.json()
        assert data["start_date"] == project.start_date.isoformat()

    def test_owner_name_is_none_when_no_owner_member(
        self, client: APIClient, project: Project
    ) -> None:
        # membership fixture not injected — project has no member, but the client
        # user is authenticated as a non-member; force-auth to bypass permission check
        # by creating a viewer membership instead
        from django.contrib.auth import get_user_model

        from trueppm_api.apps.access.models import Role

        User = get_user_model()
        viewer = User.objects.create_user(username="viewer_nm", password="pw")
        ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
        c = APIClient()
        c.force_authenticate(user=viewer)
        res = c.get(self.url(project.pk))
        assert res.status_code == 200
        # No owner-role member exists — owner_name should be None
        assert res.json()["owner_name"] is None

    def test_on_track_health_when_all_scheduled_complete(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        make_task(
            project,
            early_finish=yesterday,
            status=TaskStatus.COMPLETE,
            percent_complete=100.0,
        )
        res = client.get(self.url(project.pk))
        assert res.status_code == 200
        assert res.json()["schedule_health"] == "on_track"
        assert res.json()["spi"] == 1.0

    def test_critical_health_when_overdue_tasks(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        # 3 overdue, 0 complete => spi = 0
        for i in range(3):
            make_task(
                project, name=f"Late {i}", early_finish=yesterday, status=TaskStatus.NOT_STARTED
            )
        res = client.get(self.url(project.pk))
        assert res.status_code == 200
        assert res.json()["schedule_health"] == "critical"
        assert res.json()["tasks_late_count"] == 3

    def test_critical_count_reflects_is_critical_tasks(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        make_task(project, name="CP task", is_critical=True)
        make_task(project, name="Non-CP task", is_critical=False)
        res = client.get(self.url(project.pk))
        assert res.json()["critical_task_count"] == 1

    def test_next_milestone_returned_when_upcoming(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        tomorrow = datetime.date.today() + datetime.timedelta(days=1)
        make_task(
            project,
            name="Phase gate",
            is_milestone=True,
            early_finish=tomorrow,
        )
        res = client.get(self.url(project.pk))
        data = res.json()
        assert data["next_milestone"] is not None
        assert data["next_milestone"]["name"] == "Phase gate"
        assert data["next_milestone"]["date"] == tomorrow.isoformat()

    def test_past_milestone_not_returned(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        make_task(project, name="Old gate", is_milestone=True, early_finish=yesterday)
        res = client.get(self.url(project.pk))
        assert res.json()["next_milestone"] is None

    def test_deleted_tasks_excluded(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        t = make_task(project, early_finish=yesterday, status=TaskStatus.NOT_STARTED)
        t.is_deleted = True
        t.save()
        res = client.get(self.url(project.pk))
        assert res.json()["tasks_late_count"] == 0

    def test_method_not_allowed_post(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        res = client.post(self.url(project.pk), {})
        assert res.status_code == 405


# ---------------------------------------------------------------------------
# GET /api/v1/projects/<pk>/attention/
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProjectAttention:
    def url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/attention/"

    def test_unauthenticated_returns_401(
        self, anon_client: APIClient, project: Project, membership: object
    ) -> None:
        res = anon_client.get(self.url(project.pk))
        assert res.status_code == 401

    def test_non_member_returns_403(
        self, other_user: object, project: Project, membership: object
    ) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.get(self.url(project.pk))
        assert res.status_code == 403

    def test_no_items_when_project_is_healthy(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        res = client.get(self.url(project.pk))
        assert res.status_code == 200
        assert res.json()["items"] == []

    def test_critical_late_task_appears(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        make_task(
            project,
            name="Critical late",
            is_critical=True,
            early_finish=yesterday,
            status=TaskStatus.IN_PROGRESS,
        )
        res = client.get(self.url(project.pk))
        items = res.json()["items"]
        assert len(items) == 1
        assert items[0]["type"] == "critical_task_late"
        assert items[0]["severity"] == "critical"
        assert items[0]["task_name"] == "Critical late"

    def test_non_critical_late_task_not_in_critical_bucket(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        make_task(
            project,
            name="Non-critical late",
            is_critical=False,
            early_finish=yesterday,
            status=TaskStatus.IN_PROGRESS,
        )
        res = client.get(self.url(project.pk))
        items = res.json()["items"]
        # Non-critical late tasks don't appear in the critical_task_late bucket
        assert not any(i["type"] == "critical_task_late" for i in items)

    def test_unassigned_approaching_task_appears(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        soon = datetime.date.today() + datetime.timedelta(days=3)
        make_task(
            project,
            name="Unassigned soon",
            assignee=None,
            early_start=soon,
            status=TaskStatus.NOT_STARTED,
        )
        res = client.get(self.url(project.pk))
        items = res.json()["items"]
        assert any(i["type"] == "unassigned_approaching" for i in items)

    def test_complete_task_not_flagged_as_critical_late(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        make_task(
            project,
            name="Already done",
            is_critical=True,
            early_finish=yesterday,
            status=TaskStatus.COMPLETE,
            percent_complete=100.0,
        )
        res = client.get(self.url(project.pk))
        assert res.json()["items"] == []

    def test_link_target_field_present_on_all_items(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        make_task(
            project,
            name="Late CP",
            is_critical=True,
            early_finish=yesterday,
            status=TaskStatus.IN_PROGRESS,
        )
        res = client.get(self.url(project.pk))
        items = res.json()["items"]
        assert len(items) > 0
        for item in items:
            assert "link_target" in item

    def test_overallocation_item_appears(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        from decimal import Decimal

        from trueppm_api.apps.resources.models import Resource, TaskResource

        resource = Resource.objects.create(
            name="Over Resource",
            max_units=Decimal("1.00"),
        )
        # Create two tasks each assigning 75% — total 150% > max_units
        task1 = make_task(project, name="Task A", status=TaskStatus.IN_PROGRESS)
        task2 = make_task(project, name="Task B", status=TaskStatus.NOT_STARTED)
        TaskResource.objects.create(task=task1, resource=resource, units=Decimal("0.75"))
        TaskResource.objects.create(task=task2, resource=resource, units=Decimal("0.75"))

        res = client.get(self.url(project.pk))
        items = res.json()["items"]
        assert any(i["type"] == "overallocation" for i in items)
        overalloc = next(i for i in items if i["type"] == "overallocation")
        assert overalloc["severity"] == "warning"
        assert overalloc["task_name"] == "Over Resource"


# ---------------------------------------------------------------------------
# GET /api/v1/projects/<pk>/my-tasks/
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProjectMyTasks:
    def url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/my-tasks/"

    def test_unauthenticated_returns_401(
        self, anon_client: APIClient, project: Project, membership: object
    ) -> None:
        res = anon_client.get(self.url(project.pk))
        assert res.status_code == 401

    def test_non_member_returns_403(
        self, other_user: object, project: Project, membership: object
    ) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.get(self.url(project.pk))
        assert res.status_code == 403

    def test_returns_empty_when_no_tasks_assigned(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        res = client.get(self.url(project.pk))
        assert res.status_code == 200
        assert res.json()["tasks"] == []

    def test_returns_task_due_this_week(
        self, client: APIClient, user: object, project: Project, membership: object
    ) -> None:
        today = datetime.date.today()
        week_start = today - datetime.timedelta(days=today.weekday())
        due = week_start + datetime.timedelta(days=2)
        make_task(
            project,
            name="My task",
            assignee=user,
            early_finish=due,
            status=TaskStatus.IN_PROGRESS,
        )
        res = client.get(self.url(project.pk))
        tasks = res.json()["tasks"]
        assert len(tasks) == 1
        assert tasks[0]["name"] == "My task"

    def test_excludes_task_due_next_week(
        self, client: APIClient, user: object, project: Project, membership: object
    ) -> None:
        today = datetime.date.today()
        next_monday = today - datetime.timedelta(days=today.weekday()) + datetime.timedelta(days=7)
        make_task(
            project,
            name="Next week",
            assignee=user,
            early_finish=next_monday,
            status=TaskStatus.NOT_STARTED,
        )
        res = client.get(self.url(project.pk))
        assert res.json()["tasks"] == []

    def test_excludes_complete_tasks(
        self, client: APIClient, user: object, project: Project, membership: object
    ) -> None:
        today = datetime.date.today()
        week_start = today - datetime.timedelta(days=today.weekday())
        due = week_start + datetime.timedelta(days=1)
        make_task(
            project,
            name="Done task",
            assignee=user,
            early_finish=due,
            status=TaskStatus.COMPLETE,
            percent_complete=100.0,
        )
        res = client.get(self.url(project.pk))
        assert res.json()["tasks"] == []

    def test_excludes_other_users_tasks(
        self, client: APIClient, other_user: object, project: Project, membership: object
    ) -> None:
        today = datetime.date.today()
        week_start = today - datetime.timedelta(days=today.weekday())
        due = week_start + datetime.timedelta(days=1)
        make_task(
            project,
            name="Not mine",
            assignee=other_user,
            early_finish=due,
            status=TaskStatus.IN_PROGRESS,
        )
        res = client.get(self.url(project.pk))
        assert res.json()["tasks"] == []

    def test_tasks_ordered_by_early_finish(
        self, client: APIClient, user: object, project: Project, membership: object
    ) -> None:
        today = datetime.date.today()
        week_start = today - datetime.timedelta(days=today.weekday())
        make_task(
            project,
            name="Later",
            assignee=user,
            early_finish=week_start + datetime.timedelta(days=4),
        )
        make_task(
            project,
            name="Earlier",
            assignee=user,
            early_finish=week_start + datetime.timedelta(days=1),
        )
        res = client.get(self.url(project.pk))
        names = [t["name"] for t in res.json()["tasks"]]
        assert names == ["Earlier", "Later"]


# ---------------------------------------------------------------------------
# Attention — baseline drift sort order (#394)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAttentionDriftSort:
    """Most-slipped critical tasks must be ordered largest drift first (#394)."""

    def test_baseline_drift_items_ordered_by_largest_slip_first(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        from trueppm_api.apps.projects.models import Baseline, BaselineTask

        baseline = Baseline.objects.create(
            project=project, name="B1", is_active=True, has_cpm_dates=True
        )
        today = datetime.date.today()
        # Five critical tasks with varying drift amounts (1, 3, 7, 2, 5 days).
        slip_days = [1, 3, 7, 2, 5]
        for i, drift in enumerate(slip_days):
            t = make_task(
                project,
                name=f"Task{i}",
                is_critical=True,
                early_finish=today + datetime.timedelta(days=drift),
            )
            BaselineTask.objects.create(
                baseline=baseline,
                task_id=t.pk,
                task_name=t.name,
                finish=today,
                duration=1,
            )

        res = client.get(f"/api/v1/projects/{project.pk}/attention/")
        assert res.status_code == 200
        import re

        drift_items = [i for i in res.json()["items"] if i["type"] == "baseline_drift"]

        # drift_days is encoded in the detail string: "Slipped +Nd vs baseline"
        def _parse_drift(item: dict) -> int:
            m = re.search(r"\+(\d+)d", item["detail"])
            return int(m.group(1)) if m else 0

        # Exactly _MAX_PER_BUCKET (3) items returned; the top 3 of the seeded
        # drifts (1/3/7/2/5) are 7, 5, 3, ordered largest-slip first. A total
        # breakage of drift detection returns zero items — which would satisfy
        # "<= 3" and skip a "len >= 2"-guarded ordering check — so assert the
        # exact count and the exact ordered drifts unconditionally.
        assert len(drift_items) == 3
        drifts = [_parse_drift(i) for i in drift_items]
        assert drifts == [7, 5, 3]


# ---------------------------------------------------------------------------
# Overview — SPI proxy uses baseline, allows SPI > 1.0 (#398)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestOverviewSpiProxy:
    def url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/overview/"

    def test_spi_above_1_when_ahead_of_schedule(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        from trueppm_api.apps.projects.models import Baseline, BaselineTask

        baseline = Baseline.objects.create(
            project=project, name="B1", is_active=True, has_cpm_dates=True
        )
        today = datetime.date.today()
        # 2 tasks planned to finish by today per baseline; both already complete.
        # A third task also complete but not in the baseline window — ahead of schedule.
        for i in range(3):
            t = make_task(
                project,
                name=f"T{i}",
                status=TaskStatus.COMPLETE,
            )
            if i < 2:
                BaselineTask.objects.create(
                    baseline=baseline,
                    task_id=t.pk,
                    task_name=t.name,
                    finish=today,
                    duration=1,
                )

        res = client.get(self.url(project.pk))
        assert res.status_code == 200
        spi = res.json().get("spi")
        # BCWP=3 (all complete), BCWS=2 (baseline tasks planned by today) → SPI=1.5
        assert spi is not None
        assert spi > 1.0

    def test_spi_no_cap_at_1_after_cpm_rerun(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        """SPI must not drift to 1.0 when CPM pushes early_finish past today."""
        from trueppm_api.apps.projects.models import Baseline, BaselineTask

        baseline = Baseline.objects.create(
            project=project, name="B1", is_active=True, has_cpm_dates=True
        )
        today = datetime.date.today()
        # 1 task planned to finish today (baseline), but CPM shifted it a week out.
        # Task is still complete → SPI = 1.0 (not degraded to 0).
        t = make_task(
            project,
            name="Shifted",
            early_finish=today + datetime.timedelta(days=7),
            status=TaskStatus.COMPLETE,
        )
        BaselineTask.objects.create(
            baseline=baseline,
            task_id=t.pk,
            task_name=t.name,
            finish=today,
            duration=1,
        )

        res = client.get(self.url(project.pk))
        spi = res.json().get("spi")
        assert spi is not None
        # BCWP=1 (complete), BCWS=1 (baseline finish=today) → SPI=1.0, not 0.
        assert spi == 1.0


# ---------------------------------------------------------------------------
# Team utilization on the overview payload (#2428)
# ---------------------------------------------------------------------------


def _this_week() -> tuple[datetime.date, datetime.date]:
    """The Mon–Sun window the overview endpoint measures (its own definition)."""
    today = datetime.date.today()
    monday = today - datetime.timedelta(days=today.weekday())
    return monday, monday + datetime.timedelta(days=6)


@pytest.mark.django_db
class TestTeamUtilization:
    """`team_utilization_pct` / `team_utilization_reason` (rule 119, #2428).

    The card used to render a bare em-dash forever: the endpoint hardcoded `None`
    with a "populated when the resource module extends this" note, long after that
    module landed. These cover the real computation and — the point of the issue —
    that an undefined ratio is distinguishable from a real 0%.
    """

    def url(self, pk: object) -> str:
        return f"/api/v1/projects/{pk}/overview/"

    def _roster(
        self,
        project: Project,
        *,
        max_units: str = "1.0",
        units_override: str | None = None,
        name: str = "Dana",
    ) -> Resource:
        resource = Resource.objects.create(name=name, max_units=Decimal(max_units))
        ProjectResource.objects.create(
            project=project,
            resource=resource,
            units_override=Decimal(units_override) if units_override is not None else None,
        )
        return resource

    def _assign_all_week(self, project: Project, resource: Resource, units: str = "1.0") -> Task:
        """Assign `resource` to a task covering the whole measured window."""
        start, end = _this_week()
        task = make_task(project, name="Wiring", early_start=start, early_finish=end)
        TaskResource.objects.create(task=task, resource=resource, units=Decimal(units))
        return task

    def test_no_roster_reports_a_reason_not_a_bare_null(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        # The bug: a null percent with nothing to explain it, so the card could not
        # tell "no one is allocated" from "this is broken".
        data = client.get(self.url(project.pk)).json()
        assert data["team_utilization_pct"] is None
        assert data["team_utilization_reason"] == "no_roster"

    def test_idle_roster_is_a_real_zero_not_a_reason(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        # Nobody allocated is a *meaningful answer*, so it must render as 0% rather
        # than as an unavailable card — that distinction is the whole issue.
        self._roster(project)
        data = client.get(self.url(project.pk)).json()
        assert data["team_utilization_pct"] == 0.0
        assert data["team_utilization_reason"] is None

    def test_fully_booked_roster_reads_100_percent(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        resource = self._roster(project)
        self._assign_all_week(project, resource)
        data = client.get(self.url(project.pk)).json()
        assert data["team_utilization_pct"] == 100.0
        assert data["team_utilization_reason"] is None

    def test_half_time_assignment_halves_the_ratio(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        resource = self._roster(project)
        self._assign_all_week(project, resource, units="0.5")
        assert client.get(self.url(project.pk)).json()["team_utilization_pct"] == 50.0

    def test_overallocation_exceeds_100_percent(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        # Two concurrent full-time tasks on one person — the state the card's
        # critical band exists to surface.
        resource = self._roster(project)
        self._assign_all_week(project, resource)
        self._assign_all_week(project, resource)
        assert client.get(self.url(project.pk)).json()["team_utilization_pct"] == 200.0

    def test_idle_roster_member_dilutes_the_ratio(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        # A rostered-but-unassigned person is idle capacity and belongs in the
        # denominator; counting only assignees would peg this team at 100%.
        busy = self._roster(project, name="Dana")
        self._roster(project, name="Ravi")
        self._assign_all_week(project, busy)
        assert client.get(self.url(project.pk)).json()["team_utilization_pct"] == 50.0

    def test_units_override_wins_over_resource_max_units(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        # "Half on this project" halves the denominator, so the same assignment
        # reads as fully booked rather than half booked.
        resource = self._roster(project, max_units="1.0", units_override="0.5")
        self._assign_all_week(project, resource, units="0.5")
        assert client.get(self.url(project.pk)).json()["team_utilization_pct"] == 100.0

    def test_off_roster_assignee_brings_its_own_capacity(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        # TaskResource does not require a ProjectResource row. Counting only the
        # roster would put these hours in the numerator with no denominator and
        # report a phantom overallocation, so the population is the union.
        stranger = Resource.objects.create(name="Contractor", max_units=Decimal("1.0"))
        self._assign_all_week(project, stranger)
        data = client.get(self.url(project.pk)).json()
        assert data["team_utilization_pct"] == 100.0
        assert data["team_utilization_reason"] is None

    def test_zero_capacity_roster_reports_no_capacity(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        # A ratio over zero capacity is undefined, not zero — so this is a reason.
        self._roster(project, max_units="0.0")
        data = client.get(self.url(project.pk)).json()
        assert data["team_utilization_pct"] is None
        assert data["team_utilization_reason"] == "no_capacity"

    def test_work_outside_the_window_is_not_counted(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        # The card answers "how loaded is this team *now*", so next month's crunch
        # must not inflate this week's reading.
        resource = self._roster(project)
        _, end = _this_week()
        future = make_task(
            project,
            name="Later",
            early_start=end + datetime.timedelta(days=14),
            early_finish=end + datetime.timedelta(days=18),
        )
        TaskResource.objects.create(task=future, resource=resource, units=Decimal("1.0"))
        assert client.get(self.url(project.pk)).json()["team_utilization_pct"] == 0.0


# ---------------------------------------------------------------------------
# Added time — the schedule risk premium on the overview payload (#2483)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestOverviewAddedTime:
    """The premium travels with project health, not only with a forecast run.

    Promoting it onto this payload is the whole point of #2483: every consumer of
    project health — cards, MCP health reads, rollups — can now answer "how much
    time is risk adding here" without running a simulation of its own.
    """

    @staticmethod
    def url(pk: object) -> str:
        return f"/api/v1/projects/{pk}/overview/"

    @staticmethod
    def make_run(project: Project, **kwargs: object) -> object:
        from trueppm_api.apps.scheduling.models import MonteCarloRun

        defaults: dict[str, object] = {
            "p50": datetime.date(2026, 10, 26),
            "p80": datetime.date(2026, 11, 4),
            "p95": datetime.date(2026, 11, 20),
            "cpm_finish": datetime.date(2026, 10, 24),
            "n_simulations": 2000,
        }
        defaults.update(kwargs)
        return MonteCarloRun.objects.create(project=project, **defaults)

    def test_reports_not_run_when_no_simulation_exists(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        data = client.get(self.url(project.pk)).json()

        assert data["risk_premium_state"] == "not_run"
        assert data["risk_premium_days"] is None

    def test_carries_the_premium_and_both_dates_it_spans(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        self.make_run(project)

        data = client.get(self.url(project.pk)).json()

        assert data["risk_premium_days"] == 11
        assert data["risk_premium_cpm_finish"] == "2026-10-24"
        assert data["risk_premium_p80"] == "2026-11-04"
        assert data["risk_premium_state"] in {"premium", "stale"}

    def test_reads_the_most_recent_run(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        self.make_run(project, p80=datetime.date(2026, 12, 25))
        newest = self.make_run(project, p80=datetime.date(2026, 11, 4))

        data = client.get(self.url(project.pk)).json()

        assert data["risk_premium_days"] == 11
        assert data["risk_premium_as_of"] == newest.taken_at.isoformat()  # type: ignore[attr-defined]

    def test_an_unestimated_project_is_unmeasurable_not_a_zero_premium(
        self, client: APIClient, project: Project, membership: object
    ) -> None:
        """The safety property, end to end.

        A flat run on a project with no three-point estimates must not reach the
        client as a premium of 0 days — that would present the least-understood
        project as the safest one.
        """
        self.make_run(
            project,
            p80=datetime.date(2026, 10, 24),
            diagnostic={
                "deterministic": True,
                "reason": "no_estimates",
                "tasks_total": 8,
                "tasks_with_variance": 0,
            },
        )

        data = client.get(self.url(project.pk)).json()

        assert data["risk_premium_state"] == "unmeasurable"
        assert data["risk_premium_reason"] == "no_estimates"
        # No commitment date is offered: a flat run's "P80" is the CPM date under
        # another name, and acting on it would mean acting on an uncomputed forecast.
        assert data["risk_premium_p80"] is None

    def test_requires_project_membership(self, project: Project, other_user: object) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        assert c.get(self.url(project.pk)).status_code == 403
