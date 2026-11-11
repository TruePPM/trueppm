"""Sprint sovereignty is enforced by the server, not by rendering (#2984).

The Unscheduled gutter presents an undated task in a PLANNED or ACTIVE sprint as
read-only, because the sprint window is its schedule and a PM-set date would be
indistinguishable from a team commitment. That rule lived only in the gutter's
rendering: ``PATCH /tasks/{id}/`` and both bulk edit paths (``update`` and the
``create``-as-edit re-create) wrote the date for any Admin.

These tests pin the maintainer's verdict, all as an Admin — the role
``can_user_edit_task`` otherwise passes unconditionally:

- PLANNED and ACTIVE sprint, undated task → a dating write is refused, on every
  write path, with the stable ``sprint_committed_dates_locked`` code on REST.
- No sprint → unguarded. COMPLETED → not this rule's refusal: dating an undated
  task bumps its status, which the pre-existing closed-sprint freeze (#2680)
  already refuses. That behavior is pinned as unchanged, not as new.
- A sprint task that already carries a date may still be rescheduled
  (ADR-0067's pull-to-commit drag).
- ``dates_locked_by_sprint`` on the read declares the same verdict.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Sprint, SprintState, Task

BULK_URL = "/api/v1/projects/{pk}/tasks/bulk/"
NEW_DATE = "2026-01-07"
LOCKED_CODE = "sprint_committed_dates_locked"

LOCKED_STATES = [SprintState.PLANNED, SprintState.ACTIVE]
CLOSED_FREEZE_MSG = "This task belongs to a closed sprint and can no longer change status."


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Sovereignty", start_date=date(2026, 1, 1), calendar=calendar
    )


@pytest.fixture
def admin_client(project: Project) -> APIClient:
    user = get_user_model().objects.create_user(username="sov_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _task(project: Project, state: str | None, **kwargs: Any) -> Task:
    sprint = None
    if state is not None:
        sprint = Sprint.objects.create(
            project=project,
            name=f"Sprint {state}",
            goal="",
            start_date=date(2026, 1, 5),
            finish_date=date(2026, 1, 16),
            state=state,
        )
    return Task.objects.create(
        project=project, name="Sprint work", duration=3, sprint=sprint, **kwargs
    )


def _patch(client: APIClient, task: Task, data: dict[str, Any]) -> Any:
    with patch("trueppm_api.apps.projects.views._enqueue_recalculate"):
        return client.patch(f"/api/v1/tasks/{task.pk}/", data, format="json")


def _bulk(client: APIClient, project: Project, op: dict[str, Any]) -> Any:
    with patch("trueppm_api.apps.projects.views._enqueue_recalculate"):
        return client.post(BULK_URL.format(pk=project.pk), {"operations": [op]}, format="json")


def _update_op(task: Task, data: dict[str, Any]) -> dict[str, Any]:
    return {"op": "update", "id": str(task.pk), "data": data}


def _recreate_op(task: Task, data: dict[str, Any]) -> dict[str, Any]:
    # A ``create`` naming an id that already exists is applied as an edit
    # (ADR-0772 guard 4) — the second bulk write path the guard must cover.
    return {"op": "create", "id": str(task.pk), "data": {"name": task.name, **data}}


# ---------------------------------------------------------------------------
# PATCH /tasks/{id}/
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("state", LOCKED_STATES)
@pytest.mark.parametrize("field", ["planned_start", "planned_finish"])
def test_patch_refuses_dating_undated_task_in_live_sprint(
    admin_client: APIClient, project: Project, state: str, field: str
) -> None:
    task = _task(project, state)
    r = _patch(admin_client, task, {field: NEW_DATE})
    assert r.status_code == 400, r.content
    assert r.data["code"] == LOCKED_CODE
    assert r.data["suggested_action"] == "remove_from_sprint"
    task.refresh_from_db()
    assert task.planned_start is None
    assert task.duration == 3


@pytest.mark.django_db
def test_patch_allows_dating_backlog_task_with_no_sprint(
    admin_client: APIClient, project: Project
) -> None:
    task = _task(project, None)
    r = _patch(admin_client, task, {"planned_start": NEW_DATE})
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.planned_start == date(2026, 1, 7)


@pytest.mark.django_db
def test_patch_completed_sprint_keeps_its_existing_freeze(
    admin_client: APIClient, project: Project
) -> None:
    """COMPLETED is out of this guard's scope; the #2680 status freeze is unchanged."""
    task = _task(project, SprintState.COMPLETED)
    r = _patch(admin_client, task, {"planned_start": NEW_DATE})
    assert r.status_code == 400, r.content
    assert r.data.get("code") != LOCKED_CODE
    assert r.data["status"] == CLOSED_FREEZE_MSG


@pytest.mark.django_db
@pytest.mark.parametrize("state", LOCKED_STATES)
def test_patch_allows_rescheduling_dated_sprint_task(
    admin_client: APIClient, project: Project, state: str
) -> None:
    """Only null → date is refused; ADR-0067's pull-to-commit drag keeps working."""
    task = _task(project, state, planned_start=date(2026, 1, 5))
    r = _patch(admin_client, task, {"planned_start": NEW_DATE})
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.planned_start == date(2026, 1, 7)


@pytest.mark.django_db
def test_patch_allows_non_date_edit_of_undated_sprint_task(
    admin_client: APIClient, project: Project
) -> None:
    task = _task(project, SprintState.ACTIVE)
    r = _patch(admin_client, task, {"name": "Renamed", "planned_start": None})
    assert r.status_code == 200, r.content


def _live_sprint(project: Project, name: str) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        goal="",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=SprintState.PLANNED,
    )


@pytest.mark.django_db
def test_patch_pulling_backlog_row_into_live_sprint_with_a_date_is_allowed(
    admin_client: APIClient, project: Project
) -> None:
    """The Board's shipped "Add to a sprint" promote sends sprint + planned_start.

    The guard keys on the task's current sprint, so this flow keeps working.
    """
    sprint = _live_sprint(project, "Target")
    task = _task(project, None)
    r = _patch(admin_client, task, {"sprint": str(sprint.pk), "planned_start": NEW_DATE})
    assert r.status_code == 200, r.content


@pytest.mark.django_db
def test_patch_moving_between_live_sprints_with_a_date_is_refused(
    admin_client: APIClient, project: Project
) -> None:
    task = _task(project, SprintState.ACTIVE)
    other = _live_sprint(project, "Next")
    r = _patch(admin_client, task, {"sprint": str(other.pk), "planned_start": NEW_DATE})
    assert r.status_code == 400, r.content
    assert r.data["code"] == LOCKED_CODE


@pytest.mark.django_db
def test_patch_removing_sprint_and_dating_is_allowed(
    admin_client: APIClient, project: Project
) -> None:
    task = _task(project, SprintState.ACTIVE)
    r = _patch(admin_client, task, {"sprint": None, "planned_start": NEW_DATE})
    assert r.status_code == 200, r.content


# ---------------------------------------------------------------------------
# POST /projects/{pk}/tasks/bulk/ — update and create-as-edit
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("make_op", [_update_op, _recreate_op], ids=["update", "recreate"])
@pytest.mark.parametrize("state", LOCKED_STATES)
def test_bulk_rejects_dating_undated_task_in_live_sprint(
    admin_client: APIClient, project: Project, state: str, make_op: Any
) -> None:
    task = _task(project, state)
    r = _bulk(admin_client, project, make_op(task, {"planned_start": NEW_DATE}))
    assert r.status_code == 207, r.data
    assert len(r.data["rejected"]) == 1
    row = r.data["rejected"][0]
    assert row["code"] == "invalid"
    assert row["id"] == str(task.pk)
    assert "sprint" in row["message"]
    task.refresh_from_db()
    assert task.planned_start is None


@pytest.mark.django_db
@pytest.mark.parametrize("make_op", [_update_op, _recreate_op], ids=["update", "recreate"])
def test_bulk_allows_dating_backlog_task_with_no_sprint(
    admin_client: APIClient, project: Project, make_op: Any
) -> None:
    task = _task(project, None)
    r = _bulk(admin_client, project, make_op(task, {"planned_start": NEW_DATE}))
    assert r.data["rejected"] == [], r.data
    task.refresh_from_db()
    assert task.planned_start == date(2026, 1, 7)


@pytest.mark.django_db
@pytest.mark.parametrize("make_op", [_update_op, _recreate_op], ids=["update", "recreate"])
def test_bulk_completed_sprint_keeps_its_existing_freeze(
    admin_client: APIClient, project: Project, make_op: Any
) -> None:
    task = _task(project, SprintState.COMPLETED)
    r = _bulk(admin_client, project, make_op(task, {"planned_start": NEW_DATE}))
    assert [row["message"] for row in r.data["rejected"]] == [f"status: {CLOSED_FREEZE_MSG}"]


@pytest.mark.django_db
@pytest.mark.parametrize("make_op", [_update_op, _recreate_op], ids=["update", "recreate"])
@pytest.mark.parametrize("state", LOCKED_STATES)
def test_bulk_allows_rescheduling_dated_sprint_task(
    admin_client: APIClient, project: Project, state: str, make_op: Any
) -> None:
    task = _task(project, state, planned_start=date(2026, 1, 5))
    r = _bulk(admin_client, project, make_op(task, {"planned_start": NEW_DATE}))
    assert r.data["rejected"] == [], r.data
    task.refresh_from_db()
    assert task.planned_start == date(2026, 1, 7)


@pytest.mark.django_db
def test_bulk_rejects_only_the_locked_row(admin_client: APIClient, project: Project) -> None:
    """One sovereign row in a ⌘A selection rejects itself, not the batch."""
    locked = _task(project, SprintState.ACTIVE)
    free = _task(project, None)
    with patch("trueppm_api.apps.projects.views._enqueue_recalculate"):
        r = admin_client.post(
            BULK_URL.format(pk=project.pk),
            {
                "operations": [
                    _update_op(locked, {"planned_start": NEW_DATE}),
                    _update_op(free, {"planned_start": NEW_DATE}),
                ]
            },
            format="json",
        )
    assert r.status_code == 207, r.data
    assert [row["index"] for row in r.data["rejected"]] == [0]
    free.refresh_from_db()
    assert free.planned_start == date(2026, 1, 7)


# ---------------------------------------------------------------------------
# dates_locked_by_sprint — the server fact the client gates off
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("state", "dated", "expected"),
    [
        (SprintState.PLANNED, False, True),
        (SprintState.ACTIVE, False, True),
        (SprintState.COMPLETED, False, False),
        (SprintState.CANCELLED, False, False),
        (None, False, False),
        (SprintState.ACTIVE, True, False),
    ],
)
def test_dates_locked_by_sprint_mirrors_the_guard(
    admin_client: APIClient, project: Project, state: str | None, dated: bool, expected: bool
) -> None:
    kwargs = {"planned_start": date(2026, 1, 5)} if dated else {}
    task = _task(project, state, **kwargs)
    r = admin_client.get(f"/api/v1/tasks/{task.pk}/")
    assert r.status_code == 200, r.content
    assert r.data["dates_locked_by_sprint"] is expected


@pytest.mark.django_db
def test_dates_locked_by_sprint_adds_no_query_per_row(
    admin_client: APIClient, project: Project
) -> None:
    """The list queryset ``select_related``s ``sprint``; the field must not N+1."""

    def count() -> int:
        with CaptureQueriesContext(connection) as ctx:
            r = admin_client.get(f"/api/v1/tasks/?project={project.pk}")
            assert r.status_code == 200, r.content
        return len(ctx.captured_queries)

    _task(project, SprintState.ACTIVE)
    baseline = count()
    for _ in range(3):
        _task(project, SprintState.PLANNED)
    assert count() == baseline


def test_locked_code_is_stable() -> None:
    from trueppm_api.apps.projects.serializers import SprintCommittedDatesLockedError

    assert SprintCommittedDatesLockedError.default_code == LOCKED_CODE
