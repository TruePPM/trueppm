"""Tests for the task-drawer progressive-disclosure annotations (#2317, ADR-0605).

``annotate_tasks_queryset`` adds two read-only booleans to TaskSerializer:
  - has_related_links — a live TaskRelation touches this task from EITHER end
  - has_recurrence    — this task owns a live TaskRecurrenceRule (it is a template)

They exist so the drawer can collapse those two Details-tab sections when they are
empty without firing ``useTaskRelations`` / ``useRecurrenceRule`` on every open,
which would defeat the ADR-0050 lazy-load. The behavior that matters is therefore
"never wrongly True" (a wrongly-True value leaves a permanently empty section
expanded, the exact defect #2315 set out to remove).
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
    Project,
    Task,
    TaskRecurrenceRule,
    TaskRelation,
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
def other_task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Site survey", duration=2)


# ---------------------------------------------------------------------------
# has_related_links
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestHasRelatedLinks:
    def test_false_when_no_relations(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
    ) -> None:
        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.status_code == 200
        assert r.data["has_related_links"] is False

    def test_true_when_task_is_the_source(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        other_task: Task,
    ) -> None:
        TaskRelation.objects.create(source=task, target=other_task)

        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["has_related_links"] is True

    def test_true_when_task_is_the_target(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        other_task: Task,
    ) -> None:
        """A relation is stored once, directed, but RelatedLinksSection unions both
        sides — so the inbound end must report populated too, or the section would
        collapse on a task that visibly has a relation."""
        TaskRelation.objects.create(source=other_task, target=task)

        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["has_related_links"] is True

    def test_soft_deleted_relation_excluded(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
        other_task: Task,
    ) -> None:
        rel = TaskRelation.objects.create(source=task, target=other_task)
        rel.soft_delete()

        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["has_related_links"] is False
        # Sanity — the tombstone row still exists; only the live filter hides it.
        assert TaskRelation.objects.filter(source=task).count() == 1

    def test_present_on_the_list_endpoint(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        task: Task,
        other_task: Task,
    ) -> None:
        """The drawer reads the task off the schedule LIST cache, not the detail
        endpoint — the annotation has to survive that path."""
        TaskRelation.objects.create(source=task, target=other_task)

        r = client.get(f"/api/v1/tasks/?project={project.pk}")
        assert r.status_code == 200
        by_id = {row["id"]: row for row in r.data["results"]}
        assert by_id[str(task.pk)]["has_related_links"] is True
        assert by_id[str(other_task.pk)]["has_related_links"] is True


# ---------------------------------------------------------------------------
# has_recurrence
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestHasRecurrence:
    def test_false_when_no_rule(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
    ) -> None:
        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.status_code == 200
        assert r.data["has_recurrence"] is False

    def test_true_for_the_template_task(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
    ) -> None:
        TaskRecurrenceRule.objects.create(task=task)

        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["has_recurrence"] is True

    def test_false_for_a_generated_occurrence(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        task: Task,
    ) -> None:
        """``is_recurring`` is True for BOTH the template and its occurrences, but only
        the template owns the rule. Keying disclosure off is_recurring would leave an
        occurrence's Recurrence section expanded and permanently empty (ADR-0090)."""
        TaskRecurrenceRule.objects.create(task=task)
        occurrence = Task.objects.create(
            project=project, name="Foundation (Apr 8)", duration=5, is_recurring=True
        )

        r = client.get(f"/api/v1/tasks/{occurrence.pk}/")
        assert r.data["has_recurrence"] is False

    def test_soft_deleted_rule_excluded(
        self,
        client: APIClient,
        membership: ProjectMembership,
        task: Task,
    ) -> None:
        rule = TaskRecurrenceRule.objects.create(task=task)
        rule.soft_delete()

        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["has_recurrence"] is False


# ---------------------------------------------------------------------------
# Perf — the two annotations are subqueries, not per-row lookups
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDisclosureAnnotationQueryCount:
    def test_query_count_constant_with_task_list_size(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
    ) -> None:
        """Both annotations are Exists() subqueries evaluated inside the list query.
        A per-row lookup would N+1 on a large schedule — this catches that regression.
        """
        for i in range(5):
            t = Task.objects.create(project=project, name=f"T{i}", duration=1)
            partner = Task.objects.create(project=project, name=f"T{i}-rel", duration=1)
            TaskRelation.objects.create(source=t, target=partner)
            TaskRecurrenceRule.objects.create(task=t)

        with CaptureQueriesContext(connection) as ctx_5:
            r5 = client.get(f"/api/v1/tasks/?project={project.pk}")
            assert r5.status_code == 200
        baseline_query_count = len(ctx_5.captured_queries)

        for i in range(5, 20):
            t = Task.objects.create(project=project, name=f"T{i}", duration=1)
            partner = Task.objects.create(project=project, name=f"T{i}-rel", duration=1)
            TaskRelation.objects.create(source=t, target=partner)
            TaskRecurrenceRule.objects.create(task=t)

        with CaptureQueriesContext(connection) as ctx_20:
            r20 = client.get(f"/api/v1/tasks/?project={project.pk}")
            assert r20.status_code == 200

        assert len(ctx_20.captured_queries) <= baseline_query_count + 2

    def test_relation_does_not_multiply_sibling_aggregates(
        self,
        client: APIClient,
        membership: ProjectMembership,
        project: Project,
        task: Task,
    ) -> None:
        """Exists() cannot fan out the row the way a joined Count would.

        The annotate block these two join is full of aggregates that need
        ``distinct=True`` precisely because multi-relation joins multiply rows. Adding
        several relations to one task must leave those counts untouched.
        """
        for i in range(3):
            partner = Task.objects.create(project=project, name=f"P{i}", duration=1)
            TaskRelation.objects.create(source=task, target=partner)

        r = client.get(f"/api/v1/tasks/{task.pk}/")
        assert r.data["has_related_links"] is True
        assert r.data["predecessor_count"] == 0
        assert r.data["linked_risks_count"] == 0
