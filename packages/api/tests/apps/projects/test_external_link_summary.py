"""Tests for the at-a-glance external-link summary annotation (#767, ADR-0153).

TaskSerializer exposes ``external_link_summary`` = {count, worst_status} on the
task list/detail endpoints, computed by two filtered aggregates in
``annotate_tasks_queryset()``. Covers: zero links, a single link, worst-status
precedence across multiple links, soft-deleted exclusion, the canonical rank
ordering (pinned so it can't drift from the web `lib/linkStatus.ts`), and no N+1.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations.models import TaskLink
from trueppm_api.apps.integrations.registry import (
    LINK_STATUS_BY_RANK,
    LINK_STATUS_CLOSED,
    LINK_STATUS_DRAFT,
    LINK_STATUS_MERGED,
    LINK_STATUS_OPEN,
    LINK_STATUS_RANK,
    LINK_STATUS_UNKNOWN,
)
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def user() -> object:
    return User.objects.create_user(username="kelly", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project() -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Foundation", duration=3)


def _link(task: Task, status: str, *, is_deleted: bool = False, n: int = 0) -> TaskLink:
    return TaskLink.objects.create(
        task=task,
        url=f"https://example.com/repo/pull/{status}-{n}",
        provider="github",
        status=status,
        is_deleted=is_deleted,
    )


def _summary(client: APIClient, task: Task) -> dict[str, object]:
    r = client.get(f"/api/v1/tasks/{task.pk}/")
    assert r.status_code == 200
    return r.data["external_link_summary"]


class TestExternalLinkSummary:
    def test_no_links(self, client: APIClient, membership: ProjectMembership, task: Task) -> None:
        assert _summary(client, task) == {"count": 0, "worst_status": None}

    def test_single_open_link(
        self, client: APIClient, membership: ProjectMembership, task: Task
    ) -> None:
        _link(task, LINK_STATUS_OPEN)
        assert _summary(client, task) == {"count": 1, "worst_status": LINK_STATUS_OPEN}

    @pytest.mark.parametrize(
        ("statuses", "expected_worst"),
        [
            ([LINK_STATUS_OPEN, LINK_STATUS_CLOSED], LINK_STATUS_CLOSED),
            ([LINK_STATUS_MERGED, LINK_STATUS_DRAFT], LINK_STATUS_DRAFT),
            ([LINK_STATUS_MERGED, LINK_STATUS_OPEN], LINK_STATUS_OPEN),
            ([LINK_STATUS_MERGED, LINK_STATUS_UNKNOWN], LINK_STATUS_MERGED),
            ([LINK_STATUS_UNKNOWN], LINK_STATUS_UNKNOWN),
            (
                [LINK_STATUS_CLOSED, LINK_STATUS_DRAFT, LINK_STATUS_OPEN, LINK_STATUS_MERGED],
                LINK_STATUS_CLOSED,
            ),
        ],
    )
    def test_worst_status_precedence(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        statuses: list[str],
        expected_worst: str,
    ) -> None:
        for i, status in enumerate(statuses):
            _link(task, status, n=i)
        summary = _summary(client, task)
        assert summary["count"] == len(statuses)
        assert summary["worst_status"] == expected_worst

    def test_soft_deleted_links_excluded(
        self, client: APIClient, membership: ProjectMembership, task: Task
    ) -> None:
        # A worse (closed) but deleted link must not win, nor count.
        _link(task, LINK_STATUS_CLOSED, is_deleted=True)
        _link(task, LINK_STATUS_MERGED)
        assert _summary(client, task) == {"count": 1, "worst_status": LINK_STATUS_MERGED}

    def test_all_links_deleted_reads_as_zero(
        self, client: APIClient, membership: ProjectMembership, task: Task
    ) -> None:
        _link(task, LINK_STATUS_OPEN, is_deleted=True)
        assert _summary(client, task) == {"count": 0, "worst_status": None}

    def test_summary_is_per_task(
        self, client: APIClient, membership: ProjectMembership, project: Project, task: Task
    ) -> None:
        # Links on a sibling task must not bleed into this task's summary.
        other = Task.objects.create(project=project, name="Framing", duration=2)
        _link(other, LINK_STATUS_CLOSED)
        _link(task, LINK_STATUS_OPEN)
        assert _summary(client, task) == {"count": 1, "worst_status": LINK_STATUS_OPEN}


class TestRankOrdering:
    """Pin the canonical precedence so it can't drift from web `lib/linkStatus.ts`."""

    def test_rank_is_most_attention_first(self) -> None:
        assert (
            LINK_STATUS_RANK[LINK_STATUS_CLOSED]
            < LINK_STATUS_RANK[LINK_STATUS_DRAFT]
            < LINK_STATUS_RANK[LINK_STATUS_OPEN]
            < LINK_STATUS_RANK[LINK_STATUS_MERGED]
            < LINK_STATUS_RANK[LINK_STATUS_UNKNOWN]
        )

    def test_rank_inverse_round_trips(self) -> None:
        for status, rank in LINK_STATUS_RANK.items():
            assert LINK_STATUS_BY_RANK[rank] == status


class TestNoNPlusOne:
    def test_list_query_count_is_constant(
        self, client: APIClient, membership: ProjectMembership, project: Project
    ) -> None:
        # Two tasks, each with links — the aggregate must not add a per-task query.
        for t in range(2):
            task = Task.objects.create(project=project, name=f"T{t}", duration=1)
            _link(task, LINK_STATUS_OPEN, n=t)
            _link(task, LINK_STATUS_CLOSED, n=t + 100)

        with CaptureQueriesContext(connection) as ctx_two:
            r = client.get(f"/api/v1/tasks/?project={project.pk}")
            assert r.status_code == 200
        baseline = len(ctx_two.captured_queries)

        # Add three more tasks with links; the query count must not grow per task.
        for t in range(2, 5):
            task = Task.objects.create(project=project, name=f"T{t}", duration=1)
            _link(task, LINK_STATUS_DRAFT, n=t)

        with CaptureQueriesContext(connection) as ctx_five:
            r = client.get(f"/api/v1/tasks/?project={project.pk}")
            assert r.status_code == 200
        assert len(ctx_five.captured_queries) == baseline
