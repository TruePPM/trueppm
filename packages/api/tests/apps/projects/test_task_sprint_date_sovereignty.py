"""Sprint sovereignty is enforced by the server, not by rendering (#2984).

The Unscheduled gutter presents an undated task in a PLANNED or ACTIVE sprint as
read-only, because the sprint window is its schedule and a PM-set date would be
indistinguishable from a team commitment. That rule lived only in the gutter's
rendering: ``PATCH /tasks/{id}/`` and both bulk edit paths (``update`` and the
``create``-as-edit re-create) wrote the date for any Admin.

These tests pin the maintainer's verdict, all as an Admin — the role
``can_user_edit_task`` otherwise passes unconditionally:

- PLANNED and ACTIVE sprint, undated BACKLOG-status task → a dating write is refused, on every
  write path, with the stable ``sprint_committed_dates_locked`` code on REST.
- No sprint → unguarded. COMPLETED → not this rule's refusal: dating an undated
  task bumps its status, which the pre-existing closed-sprint freeze (#2680)
  already refuses. That behavior is pinned as unchanged, not as new.
- A sprint task that already carries a date may still be rescheduled
  (ADR-0067's pull-to-commit drag).
- A committed (NOT_STARTED / IN_PROGRESS / REVIEW) undated sprint task may be
  dated: the gutter does not show it, and Gantt drag/resize (ADR-0067) and ADR-0603
  "Commit start" write its first ``planned_start``.
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
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)

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
    # BACKLOG by default: the lock covers backlog-status rows only, the set the
    # Unscheduled gutter renders read-only. Tests of other statuses pass ``status``.
    kwargs.setdefault("status", TaskStatus.BACKLOG)
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
    task = _task(project, SprintState.COMPLETED, status=TaskStatus.NOT_STARTED)
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


#: Committed statuses an undated sprint task can hold. The ADR-0168 floor dates
#: them from the sprint window, so the Gantt drag/resize (ADR-0067) and ADR-0603
#: "Commit start" must still be able to write their first ``planned_start``.
COMMITTED_STATUSES = [TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS, TaskStatus.REVIEW]


@pytest.mark.django_db
@pytest.mark.parametrize("state", LOCKED_STATES)
@pytest.mark.parametrize("status", COMMITTED_STATUSES)
@pytest.mark.parametrize(
    "change",
    [
        {"planned_start": NEW_DATE},
        # A resize of an undated bar commits both ends at once.
        {"planned_start": NEW_DATE, "planned_finish": "2026-01-09"},
    ],
    ids=["drag", "resize"],
)
def test_patch_allows_dating_committed_status_sprint_task(
    admin_client: APIClient, project: Project, state: str, status: str, change: dict[str, str]
) -> None:
    """Only backlog-status rows are locked; committed sprint work stays datable."""
    task = _task(project, state, status=status)
    r = _patch(admin_client, task, change)
    assert r.status_code == 200, r.content
    assert r.data["dates_locked_by_sprint"] is False


@pytest.mark.django_db
def test_patch_committing_and_dating_a_backlog_row_in_one_write_is_allowed(
    admin_client: APIClient, project: Project
) -> None:
    """The guard reads the post-write status, as it reads the post-write sprint."""
    task = _task(project, SprintState.ACTIVE)
    r = _patch(admin_client, task, {"status": TaskStatus.NOT_STARTED, "planned_start": NEW_DATE})
    assert r.status_code == 200, r.content


@pytest.mark.django_db
def test_patch_board_schedule_task_dialog_payload_is_allowed(
    admin_client: APIClient, project: Project
) -> None:
    """Residual (accepted): the Board's ScheduleTaskDialog payload must keep working.

    BacklogBand ··· sends ``{planned_start, status: NOT_STARTED, sprint: <current>}``.
    The guard reads the status after the write, so this leaves Backlog and dates the
    row in one edit and is allowed. Flagged to the maintainer on the MR.
    """
    task = _task(project, SprintState.ACTIVE)
    assert task.sprint is not None
    r = _patch(
        admin_client,
        task,
        {
            "planned_start": NEW_DATE,
            "status": TaskStatus.NOT_STARTED,
            "sprint": str(task.sprint.pk),
        },
    )
    assert r.status_code == 200, r.content


@pytest.mark.django_db
def test_post_create_with_live_sprint_backlog_and_date_is_not_guarded(
    admin_client: APIClient, project: Project
) -> None:
    """Residual (accepted): creates are never guarded (``instance is None``)."""
    sprint = _live_sprint(project, "Create target")
    with patch("trueppm_api.apps.projects.views._enqueue_recalculate"):
        r = admin_client.post(
            "/api/v1/tasks/",
            {
                "project": str(project.pk),
                "name": "Created dated",
                "duration": 3,
                "sprint": str(sprint.pk),
                "status": TaskStatus.BACKLOG,
                "planned_start": NEW_DATE,
            },
            format="json",
        )
    assert r.status_code == 201, r.content


@pytest.mark.django_db
@pytest.mark.parametrize("state", [SprintState.COMPLETED, SprintState.CANCELLED])
def test_patch_dating_backlog_task_in_closed_sprint_is_not_this_guards_refusal(
    admin_client: APIClient, project: Project, state: str
) -> None:
    """A BACKLOG task in a COMPLETED/CANCELLED sprint is outside this guard's states.

    The #2680 closed-sprint freeze applies only when dating changes status; this pins
    whatever happens today. Client gating on the field is #4938.
    """
    task = _task(project, state)
    r = _patch(admin_client, task, {"planned_start": NEW_DATE})
    # Dating leaves a BACKLOG row's status alone, so the #2680 freeze (status
    # changes only) does not fire either: the write succeeds. TODO(#4938)
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
    task = _task(project, SprintState.COMPLETED, status=TaskStatus.NOT_STARTED)
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
    ("state", "dated", "status", "expected"),
    [
        (SprintState.PLANNED, False, TaskStatus.BACKLOG, True),
        (SprintState.ACTIVE, False, TaskStatus.BACKLOG, True),
        (SprintState.ACTIVE, False, TaskStatus.NOT_STARTED, False),
        (SprintState.ACTIVE, False, TaskStatus.IN_PROGRESS, False),
        (SprintState.PLANNED, False, TaskStatus.REVIEW, False),
        (SprintState.COMPLETED, False, TaskStatus.BACKLOG, False),
        (SprintState.CANCELLED, False, TaskStatus.BACKLOG, False),
        (None, False, TaskStatus.BACKLOG, False),
        (SprintState.ACTIVE, True, TaskStatus.BACKLOG, False),
    ],
)
def test_dates_locked_by_sprint_mirrors_the_guard(
    admin_client: APIClient,
    project: Project,
    state: str | None,
    dated: bool,
    status: str,
    expected: bool,
) -> None:
    kwargs: dict[str, Any] = {"status": status}
    if dated:
        kwargs["planned_start"] = date(2026, 1, 5)
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
