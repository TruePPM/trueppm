"""Tests for GET /api/v1/projects/<pk>/status-summary/ (issue #205).

The recency/forecast half of this suite guards #2903: ``monte_carlo_p80``,
``last_saved`` and ``recalculated_at`` were returned as unconditional nulls behind a
comment whose stated reason was wrong, while all three underlying values existed.
"""

from __future__ import annotations

import datetime

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus
from trueppm_api.apps.scheduling.models import MonteCarloRun

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


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
def project(user: object, calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Test Project",
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
    )
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


@pytest.fixture
def tasks(project: Project) -> list[Task]:
    today = datetime.date(2026, 4, 27)
    return [
        Task.objects.create(
            project=project,
            name="Critical A",
            wbs_path="1",
            duration=5,
            is_critical=True,
            total_float=0,
            status=TaskStatus.IN_PROGRESS,
            early_start=today - datetime.timedelta(days=3),
            early_finish=today + datetime.timedelta(days=2),
        ),
        Task.objects.create(
            project=project,
            name="At Risk B",
            wbs_path="2",
            duration=5,
            is_critical=False,
            total_float=3,
            status=TaskStatus.IN_PROGRESS,
            early_start=today,
            early_finish=today + datetime.timedelta(days=5),
        ),
        Task.objects.create(
            project=project,
            name="Safe C",
            wbs_path="3",
            duration=10,
            is_critical=False,
            total_float=20,
            status=TaskStatus.NOT_STARTED,
            early_start=today + datetime.timedelta(days=5),
            early_finish=today + datetime.timedelta(days=15),
        ),
        Task.objects.create(
            project=project,
            name="Done D",
            wbs_path="4",
            duration=3,
            is_critical=True,
            total_float=0,
            status=TaskStatus.COMPLETE,
        ),
    ]


class TestStatusSummary:
    def test_returns_correct_counts(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        url = f"/api/v1/projects/{project.pk}/status-summary/"
        resp = client.get(url)
        assert resp.status_code == 200
        data = resp.json()
        assert data["task_count"] == 4
        # critical_count excludes the COMPLETE task
        assert data["critical_count"] == 1
        # at_risk_count: total_float <= 5 and not COMPLETE (A + B)
        assert data["at_risk_count"] == 2

    def test_at_risk_tasks_list(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        url = f"/api/v1/projects/{project.pk}/status-summary/"
        resp = client.get(url)
        assert resp.status_code == 200
        wbs_list = [t["wbs"] for t in resp.json()["at_risk_tasks"]]
        assert "1" in wbs_list
        assert "2" in wbs_list
        assert "3" not in wbs_list

    def test_critical_tasks_list(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        url = f"/api/v1/projects/{project.pk}/status-summary/"
        resp = client.get(url)
        data = resp.json()
        wbs_list = [t["wbs"] for t in data["critical_tasks"]]
        # Only the non-COMPLETE critical task
        assert "1" in wbs_list
        assert "4" not in wbs_list

    # -----------------------------------------------------------------------
    # #2903 — the three fields that were hard-coded to null
    #
    # A hard null is worse than a missing key for an API or MCP consumer: it is
    # indistinguishable from "no data yet", so automation keyed on that distinction
    # was silently wrong for every project that HAD run a forecast. Each field below
    # is asserted twice — once for the real value, once for the null that now means
    # something.
    # -----------------------------------------------------------------------

    def test_p80_is_the_latest_monte_carlo_runs_p80(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        MonteCarloRun.objects.create(
            project=project, p80=datetime.date(2026, 10, 1), n_simulations=500
        )
        newest = MonteCarloRun.objects.create(
            project=project, p80=datetime.date(2026, 11, 3), n_simulations=500
        )

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["monte_carlo_p80"] == "2026-11-03"
        assert newest.p80 == datetime.date(2026, 11, 3)

    def test_p80_is_null_only_when_no_run_exists(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """Null now carries a fact — "no forecast" — rather than "not implemented"."""
        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["monte_carlo_p80"] is None

    def test_p80_ignores_another_projects_run(
        self, client: APIClient, project: Project, calendar: Calendar, tasks: list[Task]
    ) -> None:
        other = Project.objects.create(
            name="Other", start_date=datetime.date(2026, 1, 1), calendar=calendar
        )
        MonteCarloRun.objects.create(
            project=other, p80=datetime.date(2026, 12, 25), n_simulations=500
        )

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["monte_carlo_p80"] is None

    def test_recalculated_at_is_the_projects_last_cpm_pass(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """The stale comment blamed the *Task* model; ``recalculated_at`` is on Project
        and has been written on every CPM pass since ADR-0114."""
        stamp = datetime.datetime(2026, 4, 27, 9, 30, tzinfo=datetime.UTC)
        Project.objects.filter(pk=project.pk).update(recalculated_at=stamp)

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["recalculated_at"] == "2026-04-27T09:30:00Z"

    def test_recalculated_at_is_null_before_the_first_pass(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        assert project.recalculated_at is None

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["recalculated_at"] is None

    def test_last_saved_is_the_newest_human_edit_across_live_tasks(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        # Every fixture row is stamped first: Task.save() treats a write as human
        # unless it opts out (ADR-0786 §4), so creating the fixture already set
        # edited_at on all four, and a partial override would leave `now` as the max.
        Task.objects.filter(project=project).update(
            edited_at=datetime.datetime(2026, 5, 1, 14, 0, tzinfo=datetime.UTC)
        )
        Task.objects.filter(pk=tasks[0].pk).update(
            edited_at=datetime.datetime(2026, 5, 2, 14, 0, tzinfo=datetime.UTC)
        )

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["last_saved"] == "2026-05-02T14:00:00Z"

    def test_last_saved_ignores_a_deleted_task(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """The live-task queryset is the one the counts use — recency must agree with it."""
        Task.objects.filter(project=project).update(
            edited_at=datetime.datetime(2026, 5, 1, 14, 0, tzinfo=datetime.UTC)
        )
        Task.objects.filter(pk=tasks[1].pk).update(
            edited_at=datetime.datetime(2026, 9, 9, 14, 0, tzinfo=datetime.UTC),
            is_deleted=True,
        )

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["last_saved"] == "2026-05-01T14:00:00Z"

    def test_last_saved_is_null_when_no_task_has_been_touched(
        self, client: APIClient, project: Project, tasks: list[Task]
    ) -> None:
        """A freshly seeded or imported project: a machine wrote every row (ADR-0786 §4)."""
        Task.objects.filter(project=project).update(edited_at=None)

        resp = client.get(f"/api/v1/projects/{project.pk}/status-summary/")

        assert resp.json()["last_saved"] is None

    def test_requires_authentication(self, anon_client: APIClient, project: Project) -> None:
        resp = anon_client.get(f"/api/v1/projects/{project.pk}/status-summary/")
        assert resp.status_code in (401, 403)

    def test_non_member_forbidden(self, other_user: object, project: Project) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        resp = c.get(f"/api/v1/projects/{project.pk}/status-summary/")
        assert resp.status_code in (403, 404)
