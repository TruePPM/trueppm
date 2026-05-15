"""Tests for the progress-anchor gate and 0→>0 auto-promote (#362).

Gate: percent_complete > 0 requires planned_start or sprint.
Auto-promote: NOT_STARTED task transitions to IN_PROGRESS when percent 0→>0.
Exemptions: ADMIN+ bypass the gate; Viewers skip the auto-promote.
"""

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
    SprintState,
    Task,
    TaskStatus,
)

User = get_user_model()

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def pm_user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def viewer_user(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def pm_membership(project: Project, pm_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=pm_user, role=Role.ADMIN)


@pytest.fixture
def member_membership(project: Project, member_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)


@pytest.fixture
def viewer_membership(project: Project, viewer_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)


@pytest.fixture
def pm_client(pm_user: object, pm_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=pm_user)
    return c


@pytest.fixture
def member_client(member_user: object, member_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


@pytest.fixture
def viewer_client(viewer_user: object, viewer_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=viewer_user)
    return c


@pytest.fixture
def unanchored_task(project: Project) -> Task:
    """Task with no planned_start and no sprint — anchored progress is blocked."""
    return Task.objects.create(project=project, name="Unanchored", duration=3)


@pytest.fixture
def anchored_task(project: Project) -> Task:
    """Task with planned_start set — progress is allowed."""
    return Task.objects.create(
        project=project, name="Anchored", duration=3, planned_start=date(2026, 5, 1)
    )


@pytest.fixture
def active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project, name="Sprint 1", state=SprintState.ACTIVE, order=1
    )


# ---------------------------------------------------------------------------
# Progress-anchor gate — rejection cases
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_gate_blocks_member_progress_without_anchor(
    member_client: APIClient, unanchored_task: Task
) -> None:
    r = member_client.patch(
        f"/api/v1/tasks/{unanchored_task.pk}/",
        {"percent_complete": 50},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["code"] == "progress_requires_anchor"
    assert r.data["suggested_action"] == "set_planned_start"


@pytest.mark.django_db
def test_gate_blocks_zero_progress_is_allowed(
    member_client: APIClient, unanchored_task: Task
) -> None:
    """percent_complete=0 is always allowed — it is the default state."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{unanchored_task.pk}/",
            {"percent_complete": 0},
            format="json",
        )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Progress-anchor gate — pass cases
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_gate_allows_progress_when_planned_start_set(
    member_client: APIClient, anchored_task: Task
) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{anchored_task.pk}/",
            {"percent_complete": 30},
            format="json",
        )
    assert r.status_code == 200
    anchored_task.refresh_from_db()
    assert anchored_task.percent_complete == 30


@pytest.mark.django_db
def test_gate_allows_progress_when_sprint_set(
    member_client: APIClient, unanchored_task: Task, active_sprint: Sprint
) -> None:
    """Setting sprint in the same payload satisfies the anchor check."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{unanchored_task.pk}/",
            {"percent_complete": 25, "sprint": str(active_sprint.pk)},
            format="json",
        )
    assert r.status_code == 200


@pytest.mark.django_db
def test_gate_allows_progress_when_task_already_has_sprint(
    member_client: APIClient, unanchored_task: Task, active_sprint: Sprint
) -> None:
    """A task already in a sprint can have progress set without resending sprint."""
    unanchored_task.sprint = active_sprint
    unanchored_task.save(update_fields=["sprint"])
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{unanchored_task.pk}/",
            {"percent_complete": 60},
            format="json",
        )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# ADMIN exemption
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_admin_bypasses_gate(pm_client: APIClient, unanchored_task: Task) -> None:
    """ADMIN+ can set progress without a schedule anchor (e.g. to correct import data)."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = pm_client.patch(
            f"/api/v1/tasks/{unanchored_task.pk}/",
            {"percent_complete": 40},
            format="json",
        )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Sprint cross-project ownership
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_gate_rejects_cross_project_sprint(
    pm_client: APIClient, calendar: Calendar, unanchored_task: Task
) -> None:
    """A sprint from a different project must be rejected."""
    other_project = Project.objects.create(
        name="Other", start_date=date(2026, 4, 1), calendar=calendar
    )
    foreign_sprint = Sprint.objects.create(
        project=other_project, name="Other Sprint", state=SprintState.ACTIVE, order=1
    )
    r = pm_client.patch(
        f"/api/v1/tasks/{unanchored_task.pk}/",
        {"sprint": str(foreign_sprint.pk)},
        format="json",
    )
    assert r.status_code == 400
    assert "sprint" in str(r.data).lower()


# ---------------------------------------------------------------------------
# Auto-promote: NOT_STARTED → IN_PROGRESS on 0 → >0
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_auto_promote_not_started_to_in_progress(
    member_client: APIClient, anchored_task: Task
) -> None:
    assert anchored_task.status == TaskStatus.NOT_STARTED
    assert anchored_task.percent_complete == 0
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{anchored_task.pk}/",
            {"percent_complete": 25},
            format="json",
        )
    assert r.status_code == 200
    anchored_task.refresh_from_db()
    assert anchored_task.status == TaskStatus.IN_PROGRESS
    assert anchored_task.actual_start == date.today()


@pytest.mark.django_db
def test_auto_promote_sets_actual_start(member_client: APIClient, anchored_task: Task) -> None:
    """actual_start is injected when transitioning to IN_PROGRESS via progress."""
    assert anchored_task.actual_start is None
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        member_client.patch(
            f"/api/v1/tasks/{anchored_task.pk}/",
            {"percent_complete": 10},
            format="json",
        )
    anchored_task.refresh_from_db()
    assert anchored_task.actual_start is not None


@pytest.mark.django_db
def test_auto_promote_skipped_when_already_in_progress(
    member_client: APIClient, anchored_task: Task
) -> None:
    anchored_task.status = TaskStatus.IN_PROGRESS
    anchored_task.percent_complete = 10
    anchored_task.save(update_fields=["status", "percent_complete"])
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{anchored_task.pk}/",
            {"percent_complete": 50},
            format="json",
        )
    assert r.status_code == 200
    anchored_task.refresh_from_db()
    assert anchored_task.status == TaskStatus.IN_PROGRESS


@pytest.mark.django_db
def test_auto_promote_skipped_when_status_explicit(
    member_client: APIClient, anchored_task: Task
) -> None:
    """Explicit status in payload always wins — auto-promote does not override."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{anchored_task.pk}/",
            {"percent_complete": 20, "status": "NOT_STARTED"},
            format="json",
        )
    assert r.status_code == 200
    anchored_task.refresh_from_db()
    assert anchored_task.status == TaskStatus.NOT_STARTED


@pytest.mark.django_db
def test_auto_promote_skipped_for_backlog_tasks(
    member_client: APIClient, project: Project, anchored_task: Task
) -> None:
    """BACKLOG tasks require an explicit status promotion — no auto-promote on progress."""
    anchored_task.status = TaskStatus.BACKLOG
    anchored_task.save(update_fields=["status"])
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{anchored_task.pk}/",
            {"percent_complete": 15},
            format="json",
        )
    assert r.status_code == 200
    anchored_task.refresh_from_db()
    assert anchored_task.status == TaskStatus.BACKLOG


@pytest.mark.django_db
def test_progress_100_routes_not_started_to_review(
    member_client: APIClient, anchored_task: Task
) -> None:
    """percent_complete=100 from NOT_STARTED on a contributor → REVIEW (existing rule)."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{anchored_task.pk}/",
            {"percent_complete": 100},
            format="json",
        )
    assert r.status_code == 200
    anchored_task.refresh_from_db()
    assert anchored_task.status == TaskStatus.REVIEW
