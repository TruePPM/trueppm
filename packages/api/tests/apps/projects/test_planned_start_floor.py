"""Tests for the project-start auto-shift (#867, supersedes the #868 rejection).

The CPM treats ``project.start_date`` as a hard floor (``early_start =
max(project_start, planned_start, …)``). #868 rejected a ``planned_start`` that
preceded it; #867 replaces that rejection: the project boundary is *elastic in
the earlier direction*. Placing a task before the project start auto-shifts
``project.start_date`` back to the task's date in the same transaction, so the
task is never a sub-start "ghost" value and the engine invariant holds because
the boundary moved. Whoever can edit task dates (Scheduler+) can trigger the
shift — Admin/Owner is *not* required, because the project start is treated as a
derived artifact of its tasks. Moving the project start *later* stays a
deliberate, separately-validated Project edit (out of scope here).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

PROJECT_START = date(2026, 4, 1)


@contextmanager
def _no_side_effects() -> Iterator[None]:
    """Mute the on_commit broadcast / async recalc — the auto-shift itself is a
    synchronous write, which is what these tests assert on."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        yield


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
# Auto-shift cases — placing a task before the project start pulls it back
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_patch_before_start_auto_shifts_project(pm_client: APIClient, task: Task) -> None:
    """A drag/typed date before the project start moves the project start to it."""
    with _no_side_effects():
        r = pm_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_start": "2026-03-15"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    task.project.refresh_from_db()
    assert task.planned_start == date(2026, 3, 15)
    assert task.project.start_date == date(2026, 3, 15)


@pytest.mark.django_db
def test_one_day_before_start_auto_shifts(pm_client: APIClient, task: Task) -> None:
    """The boundary is elastic: even one day before pulls the project start back."""
    with _no_side_effects():
        r = pm_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_start": "2026-03-31"},
            format="json",
        )
    assert r.status_code == 200
    task.project.refresh_from_db()
    assert task.project.start_date == date(2026, 3, 31)


@pytest.mark.django_db
def test_full_put_before_start_auto_shifts(pm_client: APIClient, task: Task) -> None:
    with _no_side_effects():
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
    assert r.status_code == 200
    task.project.refresh_from_db()
    assert task.project.start_date == date(2026, 3, 15)


@pytest.mark.django_db
def test_member_can_auto_shift_without_project_admin(project: Project) -> None:
    """#867: the implicit shift rides task-write permission, NOT the Admin gate a
    direct project-start edit requires. A Team Member (MEMBER+ may create tasks
    but cannot PATCH project.start_date) moves the boundary by creating a task
    before it — the project start is a derived artifact of its tasks."""
    member = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member)
    with _no_side_effects():
        r = c.post(
            "/api/v1/tasks/",
            {
                "name": "Early",
                "duration": 2,
                "project": str(project.pk),
                "planned_start": "2026-03-15",
            },
            format="json",
        )
    assert r.status_code == 201
    project.refresh_from_db()
    assert project.start_date == date(2026, 3, 15)


# ---------------------------------------------------------------------------
# No-shift cases — at or after the project start the boundary is untouched
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_planned_start_equal_to_project_start_no_shift(pm_client: APIClient, task: Task) -> None:
    with _no_side_effects():
        r = pm_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_start": "2026-04-01"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    task.project.refresh_from_db()
    assert task.planned_start == PROJECT_START
    assert task.project.start_date == PROJECT_START  # unchanged


@pytest.mark.django_db
def test_planned_start_after_project_start_no_shift(pm_client: APIClient, task: Task) -> None:
    with _no_side_effects():
        r = pm_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_start": "2026-05-01"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    task.project.refresh_from_db()
    assert task.planned_start == date(2026, 5, 1)
    assert task.project.start_date == PROJECT_START  # unchanged


@pytest.mark.django_db
def test_update_without_planned_start_no_shift(pm_client: APIClient, task: Task) -> None:
    """A payload that does not touch planned_start never moves the boundary."""
    with _no_side_effects():
        r = pm_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"name": "Renamed"},
            format="json",
        )
    assert r.status_code == 200
    task.project.refresh_from_db()
    assert task.project.start_date == PROJECT_START


# ---------------------------------------------------------------------------
# Create + bulk paths auto-shift too (all serializer-backed writes)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_before_start_auto_shifts(pm_client: APIClient, project: Project) -> None:
    with _no_side_effects():
        r = pm_client.post(
            "/api/v1/tasks/",
            {
                "name": "New",
                "duration": 3,
                "project": str(project.pk),
                "planned_start": "2026-03-15",
            },
            format="json",
        )
    assert r.status_code == 201
    created = Task.objects.get(project=project, name="New")
    assert created.planned_start == date(2026, 3, 15)
    project.refresh_from_db()
    assert project.start_date == date(2026, 3, 15)


@pytest.mark.django_db
def test_bulk_update_before_start_auto_shifts(
    pm_client: APIClient, project: Project, task: Task
) -> None:
    with _no_side_effects():
        r = pm_client.post(
            f"/api/v1/projects/{project.pk}/tasks/bulk/",
            {
                "operations": [
                    {"op": "update", "id": str(task.pk), "data": {"planned_start": "2026-03-15"}}
                ]
            },
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    project.refresh_from_db()
    assert task.planned_start == date(2026, 3, 15)
    assert project.start_date == date(2026, 3, 15)


@pytest.mark.django_db
def test_bulk_create_before_start_auto_shifts(pm_client: APIClient, project: Project) -> None:
    with _no_side_effects():
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
    assert r.status_code == 200
    project.refresh_from_db()
    assert project.start_date == date(2026, 3, 15)


# ---------------------------------------------------------------------------
# Working-day floor field (#884) — start_floor surface is unchanged by #867
# ---------------------------------------------------------------------------

# 2026-05-30 is a Saturday; the first working day on/after it is Monday 2026-06-01.
WEEKEND_START = date(2026, 5, 30)


@pytest.fixture
def weekend_project(calendar: Calendar) -> Project:
    return Project.objects.create(name="WP", start_date=WEEKEND_START, calendar=calendar)


@pytest.fixture
def weekend_client(weekend_project: Project, pm_user: object) -> APIClient:
    ProjectMembership.objects.create(project=weekend_project, user=pm_user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=pm_user)
    return c


@pytest.mark.django_db
def test_project_detail_start_floor_field(
    weekend_client: APIClient, weekend_project: Project
) -> None:
    """The project detail serializer still exposes the working-day floor (#884)."""
    r = weekend_client.get(f"/api/v1/projects/{weekend_project.pk}/")
    assert r.status_code == 200
    assert r.data["start_date"] == "2026-05-30"
    assert r.data["start_floor"] == "2026-06-01"


@pytest.mark.django_db
def test_working_day_start_floor_equals_start(pm_client: APIClient, project: Project) -> None:
    """When the start is already a working day (Wed 2026-04-01), floor == start."""
    r = pm_client.get(f"/api/v1/projects/{project.pk}/")
    assert r.status_code == 200
    assert r.data["start_floor"] == "2026-04-01"


@pytest.mark.django_db
def test_first_working_day_respects_calendar_exception(weekend_project: Project) -> None:
    """A holiday exception on the Monday pushes the floor to Tuesday (#884)."""
    from trueppm_api.apps.projects.models import CalendarException
    from trueppm_api.apps.projects.utilization import first_working_day

    CalendarException.objects.create(
        calendar=weekend_project.calendar,
        exc_start=date(2026, 6, 1),
        exc_end=date(2026, 6, 1),
        description="Holiday",
    )
    weekend_project.refresh_from_db()
    assert first_working_day(weekend_project) == date(2026, 6, 2)
