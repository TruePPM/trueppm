"""Tests for Board batch 3 PPM signal annotations and click-through filters.

ADR-0035 adds four read-only annotations to TaskSerializer:
  - predecessor_count       — count of live incoming dependency edges
  - is_blocked              — True when any predecessor is not COMPLETE
  - linked_risks_count      — count of active linked risks (OPEN + MITIGATING)
  - linked_risks_max_severity — Max(probability * impact) across active risks

It also adds ?task=<uuid> filters to RiskViewSet and DependencyViewSet so the
board can fetch the full pred/succ list and risk register entries on click.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Risk,
    RiskStatus,
    RiskTask,
    Task,
    TaskStatus,
)

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="kelly", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Foundation", duration=5)


@pytest.fixture
def predecessor(project: Project) -> Task:
    return Task.objects.create(
        project=project, name="Site survey", duration=2, status=TaskStatus.NOT_STARTED
    )


@pytest.fixture
def completed_predecessor(project: Project) -> Task:
    return Task.objects.create(
        project=project, name="Permit", duration=1, status=TaskStatus.COMPLETE
    )


# ---------------------------------------------------------------------------
# predecessor_count + is_blocked
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPredecessorAnnotations:
    def test_no_predecessors_returns_zero_and_unblocked(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
    ) -> None:
        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.status_code == 200
        assert r.data["predecessor_count"] == 0
        assert r.data["is_blocked"] is False

    def test_count_excludes_soft_deleted(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        task: Task,
        predecessor: Task,
    ) -> None:
        live = Dependency.objects.create(predecessor=predecessor, successor=task)
        ghost_pred = Task.objects.create(project=project, name="Ghost", duration=1)
        ghost = Dependency.objects.create(predecessor=ghost_pred, successor=task)
        ghost.is_deleted = True
        ghost.save()

        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["predecessor_count"] == 1
        # Sanity — both Dependency rows exist, only the live one counts.
        assert Dependency.objects.filter(successor=task).count() == 2
        _ = live

    def test_blocked_when_predecessor_not_complete(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        predecessor: Task,
    ) -> None:
        Dependency.objects.create(predecessor=predecessor, successor=task)
        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["is_blocked"] is True

    def test_unblocked_when_all_predecessors_complete(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        completed_predecessor: Task,
    ) -> None:
        Dependency.objects.create(predecessor=completed_predecessor, successor=task)
        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["predecessor_count"] == 1
        assert r.data["is_blocked"] is False

    def test_blocked_when_any_predecessor_not_complete(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        predecessor: Task,
        completed_predecessor: Task,
    ) -> None:
        # Mixed predecessors: one COMPLETE, one not.  Blocked if ANY is not COMPLETE.
        Dependency.objects.create(predecessor=completed_predecessor, successor=task)
        Dependency.objects.create(predecessor=predecessor, successor=task)
        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["predecessor_count"] == 2
        assert r.data["is_blocked"] is True


# ---------------------------------------------------------------------------
# linked_risks_count + linked_risks_max_severity
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRiskLinkAnnotations:
    def test_no_risks_returns_zero_and_null_severity(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
    ) -> None:
        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["linked_risks_count"] == 0
        assert r.data["linked_risks_max_severity"] is None

    def test_active_risk_counted(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        task: Task,
    ) -> None:
        risk = Risk.objects.create(
            project=project, title="Weather delay", probability=4, impact=3, status=RiskStatus.OPEN
        )
        RiskTask.objects.create(risk=risk, task=task)

        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["linked_risks_count"] == 1
        assert r.data["linked_risks_max_severity"] == 12

    def test_resolved_risks_excluded(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        task: Task,
    ) -> None:
        # Three linked risks: 1 OPEN, 1 MITIGATING (counted), 1 RESOLVED (excluded).
        active1 = Risk.objects.create(
            project=project, title="A", probability=2, impact=2, status=RiskStatus.OPEN
        )
        active2 = Risk.objects.create(
            project=project, title="B", probability=4, impact=4, status=RiskStatus.MITIGATING
        )
        resolved = Risk.objects.create(
            project=project, title="C", probability=5, impact=5, status=RiskStatus.RESOLVED
        )
        for r_obj in (active1, active2, resolved):
            RiskTask.objects.create(risk=r_obj, task=task)

        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["linked_risks_count"] == 2
        # Resolved risk has severity 25 but is excluded; max of (4, 16) = 16.
        assert r.data["linked_risks_max_severity"] == 16

    def test_soft_deleted_risk_excluded(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        task: Task,
    ) -> None:
        live = Risk.objects.create(
            project=project, title="Live", probability=3, impact=3, status=RiskStatus.OPEN
        )
        ghost = Risk.objects.create(
            project=project, title="Ghost", probability=5, impact=5, status=RiskStatus.OPEN
        )
        RiskTask.objects.create(risk=live, task=task)
        RiskTask.objects.create(risk=ghost, task=task)
        ghost.is_deleted = True
        ghost.save()

        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["linked_risks_count"] == 1
        assert r.data["linked_risks_max_severity"] == 9


# ---------------------------------------------------------------------------
# Risk + Dependency ?task=<uuid> filters (click-through endpoints)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskFilteredEndpoints:
    def test_risks_filtered_by_task(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        task: Task,
    ) -> None:
        linked = Risk.objects.create(
            project=project, title="Linked", probability=2, impact=2, status=RiskStatus.OPEN
        )
        unlinked = Risk.objects.create(
            project=project, title="Unlinked", probability=2, impact=2, status=RiskStatus.OPEN
        )
        RiskTask.objects.create(risk=linked, task=task)

        r = client.get(f"/api/v1/projects/{project.pk}/risks/?task={task.pk}")
        assert r.status_code == 200
        ids = {row["id"] for row in r.data["results"]}
        assert str(linked.pk) in ids
        assert str(unlinked.pk) not in ids

    def test_dependencies_filtered_by_task_returns_both_directions(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        task: Task,
        predecessor: Task,
    ) -> None:
        successor = Task.objects.create(project=project, name="Frame", duration=3)
        incoming = Dependency.objects.create(predecessor=predecessor, successor=task)
        outgoing = Dependency.objects.create(predecessor=task, successor=successor)
        unrelated_a = Task.objects.create(project=project, name="Far A", duration=1)
        unrelated_b = Task.objects.create(project=project, name="Far B", duration=1)
        unrelated = Dependency.objects.create(predecessor=unrelated_a, successor=unrelated_b)

        r = client.get(f"/api/v1/dependencies/?task={task.pk}")
        assert r.status_code == 200
        ids = {row["id"] for row in r.data["results"]}
        assert str(incoming.pk) in ids
        assert str(outgoing.pk) in ids
        assert str(unrelated.pk) not in ids


# ---------------------------------------------------------------------------
# N+1 guard — annotations must not multiply queries with task list size
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAnnotationQueryCount:
    def test_query_count_constant_with_task_list_size(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
    ) -> None:
        """Adding more tasks (each with deps + risks) must not multiply the query count.

        The four annotations are queryset-level (subqueries / aggregates);
        per-row Python lookups would explode N+1. This test catches that regression.
        """
        # Build 5 tasks, each with 1 predecessor and 2 linked risks.
        for i in range(5):
            t = Task.objects.create(project=project, name=f"T{i}", duration=1)
            pred = Task.objects.create(project=project, name=f"T{i}-pred", duration=1)
            Dependency.objects.create(predecessor=pred, successor=t)
            for j in range(2):
                r = Risk.objects.create(
                    project=project,
                    title=f"R{i}-{j}",
                    probability=2,
                    impact=2,
                    status=RiskStatus.OPEN,
                )
                RiskTask.objects.create(risk=r, task=t)

        with CaptureQueriesContext(connection) as ctx_5:
            r5 = client.get(f"/api/v1/tasks/?project={project.pk}")
            assert r5.status_code == 200
        baseline_query_count = len(ctx_5.captured_queries)

        # Triple the task population; query count should remain comparable.
        for i in range(5, 20):
            t = Task.objects.create(project=project, name=f"T{i}", duration=1)
            pred = Task.objects.create(project=project, name=f"T{i}-pred", duration=1)
            Dependency.objects.create(predecessor=pred, successor=t)
            for j in range(2):
                r = Risk.objects.create(
                    project=project,
                    title=f"R{i}-{j}",
                    probability=2,
                    impact=2,
                    status=RiskStatus.OPEN,
                )
                RiskTask.objects.create(risk=r, task=t)

        with CaptureQueriesContext(connection) as ctx_20:
            r20 = client.get(f"/api/v1/tasks/?project={project.pk}")
            assert r20.status_code == 200

        # Allow a small slack for percent_complete summary rollups (one per
        # summary task), but the four annotations themselves must not scale
        # per-row.  4× growth of the task population must not 4× the queries.
        assert len(ctx_20.captured_queries) <= baseline_query_count + 5, (
            f"Annotation N+1 regression: {baseline_query_count} → "
            f"{len(ctx_20.captured_queries)} queries when task count grew 5 → 20."
        )
