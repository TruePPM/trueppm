"""Tests for the TECH_DEBT task type and its visibility surfaces (ADR-0178, #1076).

Tech debt is a first-class TaskType so a team can track, filter, and chart
remediation work distinctly. The key invariant under test is the one that
separates it from EPIC: tech debt is *schedulable* work, so it counts toward
the committed-delivery aggregates (velocity) and is only set apart by reporting
(the ``?type=`` filter), never by exclusion.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Task,
    TaskStatus,
    TaskType,
)

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Std")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def member(project: Project) -> object:
    u = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.MEMBER)
    return u


@pytest.fixture
def client(member: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member)
    return c


def test_tech_debt_is_a_valid_task_type() -> None:
    """TECH_DEBT is registered with the canonical value/label."""
    assert TaskType.TECH_DEBT.value == "tech_debt"
    assert ("tech_debt", "Tech Debt") in TaskType.choices


def test_create_task_with_tech_debt_type(client: APIClient, project: Project) -> None:
    """A client can create a tech-debt task through the public API."""
    resp = client.post(
        "/api/v1/tasks/",
        {"project": str(project.pk), "name": "Pay down auth module", "type": "tech_debt"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["type"] == "tech_debt"


def test_type_filter_narrows_to_tech_debt(client: APIClient, project: Project) -> None:
    """``?type=tech_debt`` returns only tech-debt tasks (backs the board lens)."""
    debt = Task.objects.create(project=project, name="Refactor", type=TaskType.TECH_DEBT)
    Task.objects.create(project=project, name="Feature", type=TaskType.STORY)
    Task.objects.create(project=project, name="Plain", type=TaskType.TASK)

    resp = client.get(f"/api/v1/tasks/?project={project.pk}&type=tech_debt")
    assert resp.status_code == 200, resp.content
    results = resp.data.get("results", resp.data)
    ids = {row["id"] for row in results}
    assert ids == {str(debt.pk)}


def test_tech_debt_counts_toward_committed_aggregates(project: Project) -> None:
    """Unlike EPIC, tech debt is schedulable and stays in the committed set.

    ``CommittedTaskManager`` (``Task.committed``) is the queryset behind every
    velocity / burndown / rollup aggregate. It excludes EPIC because an epic is a
    grouping node, not work. ADR-0178 made debt the deliberate opposite: it must
    NOT join that exclusion, or velocity would understate consumed capacity.
    """
    debt = Task.objects.create(
        project=project,
        name="Debt",
        type=TaskType.TECH_DEBT,
        status=TaskStatus.IN_PROGRESS,
    )
    epic = Task.objects.create(
        project=project,
        name="Epic",
        type=TaskType.EPIC,
        status=TaskStatus.IN_PROGRESS,
    )

    committed = set(Task.committed.filter(project=project).values_list("pk", flat=True))
    assert debt.pk in committed
    assert epic.pk not in committed
