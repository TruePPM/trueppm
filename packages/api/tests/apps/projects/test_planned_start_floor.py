"""Tests for the project-start floor guard (#868).

A task's ``planned_start`` may not precede the project's ``start_date``. The CPM
already clamps ``early_start`` to the project start, so a persisted sub-start
``planned_start`` is a "ghost" value; the API rejects it with a structured
``planned_start_before_project_start`` code the frontend maps to its
snap/move/cancel prompt. There is no role exemption — the supported escape is
moving the project start date (Admin+-gated on the Project serializer).
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

PROJECT_START = date(2026, 4, 1)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=PROJECT_START, calendar=calendar)


@pytest.fixture
def pm_user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def pm_membership(project: Project, pm_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=pm_user, role=Role.ADMIN)


@pytest.fixture
def pm_client(pm_user: object, pm_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=pm_user)
    return c


@pytest.fixture
def task(project: Project) -> Task:
    """A task with no planned_start yet — the drag target."""
    return Task.objects.create(project=project, name="T", duration=3)


# ---------------------------------------------------------------------------
# Rejection cases
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_rejects_planned_start_before_project_start(pm_client: APIClient, task: Task) -> None:
    r = pm_client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"planned_start": "2026-03-15"},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["code"] == "planned_start_before_project_start"
    assert r.data["suggested_action"] == "snap_to_project_start"
    # The project start is echoed back so the frontend can prefill "snap".
    assert r.data["project_start_date"] == "2026-04-01"
    task.refresh_from_db()
    assert task.planned_start is None  # nothing persisted


@pytest.mark.django_db
def test_rejects_one_day_before_start(pm_client: APIClient, task: Task) -> None:
    """The boundary is strict: the day before the project start is rejected."""
    r = pm_client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"planned_start": "2026-03-31"},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["code"] == "planned_start_before_project_start"


@pytest.mark.django_db
def test_no_role_exemption_admin_also_rejected(pm_client: APIClient, task: Task) -> None:
    """Unlike the progress-anchor gate, Admin+ is NOT exempt — the escape is to
    move the project start, not to bypass the floor per task."""
    r = pm_client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"planned_start": "2026-01-01"},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["code"] == "planned_start_before_project_start"


@pytest.mark.django_db
def test_full_put_before_start_also_rejected(pm_client: APIClient, task: Task) -> None:
    r = pm_client.put(
        f"/api/v1/tasks/{task.pk}/",
        {
            "name": "T",
            "duration": 3,
            "planned_start": "2026-03-15",
            "project": str(task.project_id),
        },
        format="json",
    )
    assert r.status_code == 400
    assert r.data["code"] == "planned_start_before_project_start"


# ---------------------------------------------------------------------------
# Pass cases
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_planned_start_equal_to_project_start_allowed(pm_client: APIClient, task: Task) -> None:
    """The boundary day itself (the "snap to project start" target) is allowed."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = pm_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_start": "2026-04-01"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.planned_start == PROJECT_START


@pytest.mark.django_db
def test_planned_start_after_project_start_allowed(pm_client: APIClient, task: Task) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = pm_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_start": "2026-05-01"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.planned_start == date(2026, 5, 1)


@pytest.mark.django_db
def test_guard_ignores_updates_without_planned_start(pm_client: APIClient, task: Task) -> None:
    """A payload that does not touch planned_start is never gated by the floor."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = pm_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"name": "Renamed"},
            format="json",
        )
    assert r.status_code == 200


@pytest.mark.django_db
def test_move_project_start_earlier_then_task_allowed(pm_client: APIClient, task: Task) -> None:
    """The supported escape: an Admin moves the project start earlier, after
    which the same task date is accepted (the "Move project start" prompt path)."""
    move = pm_client.patch(
        f"/api/v1/projects/{task.project_id}/",
        {"start_date": "2026-03-01"},
        format="json",
    )
    assert move.status_code == 200
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = pm_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_start": "2026-03-15"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.planned_start == date(2026, 3, 15)


# ---------------------------------------------------------------------------
# Other write paths return the structured 400 (not a 500) — create + bulk
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_before_start_returns_structured_400(pm_client: APIClient, project: Project) -> None:
    """POST /tasks/ with a sub-start planned_start is a clean 400, not a 500."""
    r = pm_client.post(
        "/api/v1/tasks/",
        {"name": "New", "duration": 3, "project": str(project.pk), "planned_start": "2026-03-15"},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["code"] == "planned_start_before_project_start"
    assert not Task.objects.filter(project=project, name="New").exists()


@pytest.mark.django_db
def test_bulk_update_before_start_returns_structured_400(
    pm_client: APIClient, project: Project, task: Task
) -> None:
    """Bulk update carrying a sub-start planned_start is a clean 400 with task_id."""
    r = pm_client.post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/",
        {
            "operations": [
                {"op": "update", "id": str(task.pk), "data": {"planned_start": "2026-03-15"}}
            ]
        },
        format="json",
    )
    assert r.status_code == 400
    assert r.data["code"] == "planned_start_before_project_start"
    assert r.data.get("task_id") == str(task.pk)
    task.refresh_from_db()
    assert task.planned_start is None


@pytest.mark.django_db
def test_bulk_create_before_start_returns_structured_400(
    pm_client: APIClient, project: Project
) -> None:
    r = pm_client.post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/",
        {
            "operations": [
                {
                    "op": "create",
                    "data": {"name": "Bulk", "duration": 2, "planned_start": "2026-03-15"},
                }
            ]
        },
        format="json",
    )
    assert r.status_code == 400
    assert r.data["code"] == "planned_start_before_project_start"
