"""remaining_points field — auto-update rules and sprint burndown math (issue #366)."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintBurnSnapshot,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import upsert_burndown_for_sprint

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm366", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std366")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P366", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=10,
        committed_task_count=1,
    )


# ---------------------------------------------------------------------------
# Auto-update: COMPLETE → remaining_points = 0
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_complete_transition_zeros_remaining_points(
    client: APIClient, project: Project, active_sprint: Sprint
) -> None:
    task = Task.objects.create(
        project=project,
        name="T",
        duration=1,
        sprint=active_sprint,
        story_points=5,
        remaining_points=3,
    )
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "COMPLETE"}, format="json")
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.remaining_points == 0


@pytest.mark.django_db
def test_complete_transition_zeros_remaining_when_null(
    client: APIClient, project: Project, active_sprint: Sprint
) -> None:
    """remaining_points=null (unset) is also zeroed on COMPLETE."""
    task = Task.objects.create(
        project=project,
        name="T",
        duration=1,
        sprint=active_sprint,
        story_points=5,
        remaining_points=None,
    )
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "COMPLETE"}, format="json")
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.remaining_points == 0


@pytest.mark.django_db
def test_complete_transition_respects_explicit_remaining_points(
    client: APIClient, project: Project, active_sprint: Sprint
) -> None:
    """Explicit remaining_points in the same payload is honoured over the auto-zero."""
    task = Task.objects.create(
        project=project, name="T", duration=1, sprint=active_sprint, story_points=5
    )
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"status": "COMPLETE", "remaining_points": 2},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.remaining_points == 2


# ---------------------------------------------------------------------------
# Auto-update: reopen from COMPLETE → remaining_points = story_points
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reopen_restores_remaining_from_story_points(
    client: APIClient, project: Project, active_sprint: Sprint
) -> None:
    task = Task.objects.create(
        project=project,
        name="T",
        duration=1,
        sprint=active_sprint,
        story_points=5,
        status=TaskStatus.COMPLETE,
        remaining_points=0,
    )
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "IN_PROGRESS"}, format="json")
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.remaining_points == 5  # restored from story_points


@pytest.mark.django_db
def test_reopen_restores_null_when_no_story_points(
    client: APIClient, project: Project, active_sprint: Sprint
) -> None:
    """When story_points is null, reopening sets remaining_points=null."""
    task = Task.objects.create(
        project=project,
        name="T",
        duration=1,
        sprint=active_sprint,
        story_points=None,
        status=TaskStatus.COMPLETE,
        remaining_points=0,
    )
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "IN_PROGRESS"}, format="json")
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.remaining_points is None


# ---------------------------------------------------------------------------
# API: remaining_points exposed and writable
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_remaining_points_returned_in_api_response(client: APIClient, project: Project) -> None:
    task = Task.objects.create(
        project=project, name="T", duration=1, story_points=8, remaining_points=6
    )
    r = client.get(f"/api/v1/tasks/{task.pk}/")
    assert r.status_code == 200
    assert r.data["remaining_points"] == 6


@pytest.mark.django_db
def test_remaining_points_writable_via_patch(client: APIClient, project: Project) -> None:
    task = Task.objects.create(project=project, name="T", duration=1, story_points=8)
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"remaining_points": 3}, format="json")
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.remaining_points == 3


# ---------------------------------------------------------------------------
# Sprint burndown: remaining_points used when set, falls back to story_points
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_burndown_uses_remaining_points_when_set(project: Project) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=10,
        committed_task_count=2,
    )
    # t1 has remaining_points set (mid-sprint re-estimate: 4→2)
    Task.objects.create(
        project=project,
        name="A",
        duration=1,
        sprint=sprint,
        story_points=4,
        remaining_points=2,
    )
    # t2 has no remaining_points — falls back to story_points
    Task.objects.create(
        project=project,
        name="B",
        duration=1,
        sprint=sprint,
        story_points=6,
        remaining_points=None,
    )
    upsert_burndown_for_sprint(sprint, snapshot_date=date(2026, 4, 5))
    snap = SprintBurnSnapshot.objects.get(sprint=sprint, snapshot_date=date(2026, 4, 5))
    # remaining = 2 (from remaining_points on t1) + 6 (from story_points fallback on t2)
    assert snap.remaining_points == 8


@pytest.mark.django_db
def test_burndown_completed_task_contributes_story_points_not_remaining(
    project: Project,
) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=5,
        committed_task_count=1,
    )
    # COMPLETE task — remaining_points=0 from auto-update, but counted in completed_points
    Task.objects.create(
        project=project,
        name="Done",
        duration=1,
        sprint=sprint,
        story_points=5,
        remaining_points=0,
        status=TaskStatus.COMPLETE,
    )
    upsert_burndown_for_sprint(sprint, snapshot_date=date(2026, 4, 5))
    snap = SprintBurnSnapshot.objects.get(sprint=sprint, snapshot_date=date(2026, 4, 5))
    assert snap.completed_points == 5
    assert snap.remaining_points == 0
