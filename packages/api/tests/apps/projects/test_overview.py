"""Tests for the project overview API endpoints (issue #99).

Covers:
  GET /api/v1/projects/<pk>/overview/
  GET /api/v1/projects/<pk>/attention/
  GET /api/v1/projects/<pk>/my-tasks/
"""

from __future__ import annotations

import datetime

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus

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
        assert data["team_utilization_pct"] is None

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
