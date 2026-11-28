"""A soft-deleted sprint no longer floors its tasks (ADR-0168, #5179).

``Sprint.soft_delete`` keeps the row and leaves ``Task.sprint_id`` pointing at it,
so ``build_sched_tasks`` has to check ``sprint.is_deleted`` itself. Without that
check the recompute that ``SprintViewSet.perform_destroy`` enqueues re-reads the
deleted sprint's ``start_date`` and changes nothing.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Sprint, SprintState, Task
from trueppm_api.apps.scheduling.services import build_sched_tasks

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    # status_date pinned to start_date so not-started tasks floor at the fixture's
    # start, not at the wall-clock date the suite runs on (ADR-0752).
    return Project.objects.create(
        name="P",
        start_date=date(2026, 4, 6),
        status_date=date(2026, 4, 6),
        calendar=Calendar.objects.create(name="Std"),
    )


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 20),
        finish_date=date(2026, 5, 1),
        state=SprintState.PLANNED,
    )


def _convert(project: Project) -> list[object]:
    rows = list(Task.committed.filter(project=project).select_related("sprint"))
    return build_sched_tasks(rows, suggest_approve=False)


def _run_recalc(project: Project) -> None:
    """Run recalculate_schedule synchronously with the idempotency lock acquired
    and broadcasts/webhooks patched out (same harness as test_auto_schedule)."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    mock_redis = MagicMock()
    mock_redis.set.return_value = "OK"
    with (
        patch("trueppm_api.core.idempotent.valkey") as mock_redis_module,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        mock_redis_module.client.return_value = mock_redis
        recalculate_schedule.run(str(project.pk))


@pytest.mark.django_db
def test_live_sprint_floors_task(project: Project, sprint: Sprint) -> None:
    """Control: a live sprint still floors its task at the sprint start."""
    Task.objects.create(project=project, name="T", duration=2, sprint=sprint)
    assert _convert(project)[0].planned_start == date(2026, 4, 20)  # type: ignore[attr-defined]


@pytest.mark.django_db
def test_soft_deleted_sprint_does_not_floor_task(project: Project, sprint: Sprint) -> None:
    task = Task.objects.create(project=project, name="T", duration=2, sprint=sprint)
    sprint.soft_delete()
    task.refresh_from_db()
    # The FK survives the soft delete; that is why the converter must check.
    assert task.sprint_id == sprint.pk

    assert _convert(project)[0].planned_start is None  # type: ignore[attr-defined]


@pytest.mark.django_db
def test_explicit_planned_start_survives_sprint_delete(project: Project, sprint: Sprint) -> None:
    """A PM-committed planned_start is not the sprint floor and is kept."""
    Task.objects.create(
        project=project, name="T", duration=2, sprint=sprint, planned_start=date(2026, 4, 27)
    )
    sprint.soft_delete()
    assert _convert(project)[0].planned_start == date(2026, 4, 27)  # type: ignore[attr-defined]


@pytest.mark.django_db
def test_deleted_sprint_check_adds_no_query(
    project: Project, sprint: Sprint, django_assert_num_queries: object
) -> None:
    for i in range(3):
        Task.objects.create(project=project, name=f"T{i}", duration=2, sprint=sprint)
    sprint.soft_delete()
    rows = list(Task.committed.filter(project=project).select_related("sprint"))
    with django_assert_num_queries(0):  # type: ignore[operator]
        build_sched_tasks(rows, suggest_approve=False)


@pytest.mark.django_db
def test_api_sprint_delete_then_recompute_moves_task_off_old_floor(
    project: Project, sprint: Sprint
) -> None:
    task = Task.objects.create(project=project, name="T", duration=2, sprint=sprint)
    _run_recalc(project)
    task.refresh_from_db()
    assert task.early_start == date(2026, 4, 20)

    user = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)
    with patch("trueppm_api.apps.projects.views._enqueue_recalculate"):
        resp = client.delete(f"/api/v1/sprints/{sprint.pk}/")
    assert resp.status_code == 204

    _run_recalc(project)
    task.refresh_from_db()
    # Off the deleted sprint's floor and back to the project start.
    assert task.early_start == date(2026, 4, 6)
    assert task.planned_start is None
