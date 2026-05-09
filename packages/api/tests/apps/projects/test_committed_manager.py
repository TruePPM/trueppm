"""Tests for Task.committed manager and its downstream consumers (#361, ADR-0057).

Covers:
  - The manager filters out BACKLOG and soft-deleted rows
  - Default Task.objects is unchanged (Board still sees BACKLOG)
  - Monte Carlo simulation excludes BACKLOG cards from the input set
  - Resource overallocation check excludes BACKLOG units from the demand sum
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus
from trueppm_api.apps.resources.models import (
    ProjectResource,
    Resource,
    TaskResource,
)
from trueppm_api.apps.resources.views import _check_overallocation

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Manager — filter behaviour
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_committed_manager_excludes_backlog(project: Project) -> None:
    Task.objects.create(
        project=project, name="committed", duration=1, status=TaskStatus.NOT_STARTED
    )
    Task.objects.create(project=project, name="backlog", duration=1, status=TaskStatus.BACKLOG)

    committed = list(Task.committed.filter(project=project))
    names = {t.name for t in committed}
    assert "committed" in names
    assert "backlog" not in names


@pytest.mark.django_db
def test_committed_manager_excludes_soft_deleted(project: Project) -> None:
    keep = Task.objects.create(project=project, name="keep", duration=1)
    drop = Task.objects.create(project=project, name="drop", duration=1)
    drop.soft_delete()

    committed_ids = {t.pk for t in Task.committed.filter(project=project)}
    assert keep.pk in committed_ids
    assert drop.pk not in committed_ids


@pytest.mark.django_db
def test_default_manager_still_sees_backlog(project: Project) -> None:
    """Board view depends on Task.objects returning BACKLOG cards (ADR-0057)."""
    Task.objects.create(project=project, name="backlog", duration=1, status=TaskStatus.BACKLOG)
    Task.objects.create(project=project, name="committed", duration=1)

    names = {t.name for t in Task.objects.filter(project=project)}
    assert names == {"backlog", "committed"}


@pytest.mark.django_db
def test_committed_manager_includes_in_progress_and_complete(project: Project) -> None:
    """The 'committed' label means 'not BACKLOG' — IN_PROGRESS/REVIEW/COMPLETE are committed."""
    for status in (
        TaskStatus.NOT_STARTED,
        TaskStatus.IN_PROGRESS,
        TaskStatus.REVIEW,
        TaskStatus.COMPLETE,
    ):
        Task.objects.create(project=project, name=str(status), duration=1, status=status)
    Task.objects.create(project=project, name="bl", duration=1, status=TaskStatus.BACKLOG)

    statuses = {t.status for t in Task.committed.filter(project=project)}
    assert statuses == {
        TaskStatus.NOT_STARTED,
        TaskStatus.IN_PROGRESS,
        TaskStatus.REVIEW,
        TaskStatus.COMPLETE,
    }


# ---------------------------------------------------------------------------
# Monte Carlo input excludes BACKLOG (scheduling/views.py)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_monte_carlo_excludes_backlog_tasks(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """A BACKLOG card must not appear in the Monte Carlo simulation input."""
    Task.objects.create(project=project, name="committed", duration=2)
    backlog = Task.objects.create(
        project=project, name="backlog", duration=2, status=TaskStatus.BACKLOG
    )

    captured_task_ids: list[str] = []

    def fake_mc(sched_project, *args, **kwargs):  # type: ignore[no-untyped-def]
        captured_task_ids.extend(t.id for t in sched_project.tasks)
        # Return a minimal MC result so the view continues happily.
        from trueppm_scheduler.engine import MonteCarloResult

        return MonteCarloResult(
            project_id=sched_project.id,
            runs=1,
            p50=date(2026, 4, 5),
            p80=date(2026, 4, 5),
            p95=date(2026, 4, 5),
            distribution=[date(2026, 4, 5)],
        )

    with patch("trueppm_scheduler.engine.monte_carlo", side_effect=fake_mc):
        r = client.post(
            f"/api/v1/projects/{project.pk}/monte-carlo/",
            {"n_simulations": 1},
            format="json",
        )

    assert r.status_code == 200, r.content
    assert str(backlog.pk) not in captured_task_ids


# ---------------------------------------------------------------------------
# Capacity check excludes BACKLOG units (resources/views.py)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_check_overallocation_excludes_backlog_demand(project: Project) -> None:
    """Backlog cards must not contribute to a resource's overallocation count."""
    resource = Resource.objects.create(
        name="Aisha", email="aisha@example.com", max_units=Decimal("1.0")
    )
    ProjectResource.objects.create(project=project, resource=resource)

    committed = Task.objects.create(project=project, name="committed", duration=2)
    backlog = Task.objects.create(
        project=project, name="backlog", duration=2, status=TaskStatus.BACKLOG
    )

    # Each task demands 0.6 — a 1.2 sum would overallocate Aisha. Excluding the
    # backlog row keeps the count at 0.6, well under capacity.
    TaskResource.objects.create(task=committed, resource=resource, units=Decimal("0.6"))
    TaskResource.objects.create(task=backlog, resource=resource, units=Decimal("0.6"))

    warnings = _check_overallocation(resource, str(project.pk))
    assert warnings == []  # only the committed 0.6 counts → not overallocated


@pytest.mark.django_db
def test_check_overallocation_still_fires_on_committed_demand(project: Project) -> None:
    """Sanity: committed-only overallocation still warns."""
    resource = Resource.objects.create(
        name="Bee", email="bee@example.com", max_units=Decimal("1.0")
    )
    ProjectResource.objects.create(project=project, resource=resource)

    a = Task.objects.create(project=project, name="A", duration=2)
    b = Task.objects.create(project=project, name="B", duration=2)
    TaskResource.objects.create(task=a, resource=resource, units=Decimal("0.6"))
    TaskResource.objects.create(task=b, resource=resource, units=Decimal("0.6"))

    warnings = _check_overallocation(resource, str(project.pk))
    assert len(warnings) == 1
    assert warnings[0]["code"] == "resource_overallocated"
