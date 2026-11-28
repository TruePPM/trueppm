"""Recalc-gating on task PATCH (#965, revised by #1500).

`TaskViewSet.perform_update` must only enqueue a CPM recalculation when a
schedule-affecting field changed. A PATCH touching only non-scheduling fields
(``notes`` / ``name``) must NOT enqueue a recalc — that was the dominant
source of drawer-edit lag. Everything else still recalculates.

``percent_complete`` was originally in the same denylist as ``notes``/``name``
on the premise that the CPM pass never reads it. #1500: ADR-0132 made that
premise false — ``percent_complete`` derives an in-progress task's remaining
duration and marks it complete at 100%, on *every* project regardless of
whether ``Project.status_date`` is set (verified directly against
``trueppm_scheduler.engine``: a bare percent_complete write shifts
``early_finish`` even with no status_date and no actuals). So a PATCH writing
only ``percent_complete`` must always recalc.

The recalc is deferred via ``transaction.on_commit``; the tests capture and
execute the on-commit callbacks so the (patched) ``_enqueue_recalculate`` is
observed.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Program,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.scheduling.models import ScheduleRequestReason

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


@pytest.fixture
def task(project: Project) -> Task:
    # planned_start is set so percent_complete > 0 passes the progress-anchor
    # gate (ADR-0057) — these tests exercise the recalc trigger, not that gate.
    return Task.objects.create(
        project=project, name="T1", duration=3, planned_start=date(2026, 4, 1)
    )


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _patch_task(
    client: APIClient,
    task: Task,
    body: dict[str, object],
    django_capture_on_commit_callbacks: object,
) -> tuple[int, int]:
    """PATCH the task, executing on-commit callbacks, and return
    (status_code, recalc_call_count)."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.projects.views._dispatch_webhooks"),
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as mock_recalc,
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", body, format="json")
    return r.status_code, mock_recalc.call_count


# ---------------------------------------------------------------------------
# Non-scheduling fields → no recalc
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_notes_only_patch_does_not_recalc(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    status, calls = _patch_task(
        client, task, {"notes": "Some context"}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 0


@pytest.mark.django_db
def test_board_lane_only_patch_does_not_recalc(
    client: APIClient,
    project: Project,
    task: Task,
    django_capture_on_commit_callbacks: object,
) -> None:
    """A lane move is presentation only, so it must not cost a full reschedule (#2967).

    ``board_lane`` is the board's second axis over ``status`` and nothing in the
    CPM engine, the rollup or any export reads it. Dragging a card from Review
    into QA touches no date, so a project-wide recalculate on every such drag
    would be pure waste — and on a busy board, a lot of it.
    """
    from trueppm_api.apps.projects.models import BoardColumnConfig

    BoardColumnConfig.objects.create(
        project=project,
        columns=[
            {
                "status": s,
                "label": s.title(),
                "visible": True,
                "color": None,
                "wip_limit": None,
                "age_threshold_days": None,
                "lanes": [{"key": "qa", "label": "QA", "wip_limit": None}]
                if s == "NOT_STARTED"
                else [],
            }
            for s in ("BACKLOG", "NOT_STARTED", "IN_PROGRESS", "REVIEW", "COMPLETE")
        ],
    )
    status, calls = _patch_task(
        client, task, {"board_lane": "qa"}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 0


@pytest.mark.django_db
def test_status_and_board_lane_patch_still_recalcs(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    """The exemption is for the lane alone — a status move still moves dates."""
    status, calls = _patch_task(
        client, task, {"status": "COMPLETE"}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 1


@pytest.mark.django_db
def test_name_only_patch_does_not_recalc(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    status, calls = _patch_task(
        client, task, {"name": "Renamed"}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 0


# ---------------------------------------------------------------------------
# Scheduling fields → recalc
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_duration_patch_recalcs(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    status, calls = _patch_task(client, task, {"duration": 5}, django_capture_on_commit_callbacks)
    assert status == 200
    assert calls == 1


@pytest.mark.django_db
def test_planned_start_patch_recalcs(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    status, calls = _patch_task(
        client, task, {"planned_start": "2026-05-01"}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 1


@pytest.mark.django_db
def test_progress_plus_status_recalcs(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    # status can move the schedule (actuals), so any write that includes a
    # non-denylisted field still recalcs even when bundled with progress.
    status, calls = _patch_task(
        client,
        task,
        {"percent_complete": 50, "status": "IN_PROGRESS"},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    assert calls == 1


@pytest.mark.django_db
def test_progress_only_patch_recalcs_with_no_status_date(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    """#1500: a percent_complete-only PATCH must recalc even with no
    ``Project.status_date`` set. ``trueppm_scheduler.engine._effective_duration_days``
    derives an in-progress task's remaining duration from percent_complete
    unconditionally (not gated on status_date) — a percent_complete-only write
    is a live CPM input on every project, not just ones with a status date.
    The ``task`` fixture's project has no status_date (see ``project`` fixture).
    """
    assert task.project.status_date is None
    status, calls = _patch_task(
        client, task, {"percent_complete": 50}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 1


@pytest.mark.django_db
def test_progress_only_patch_recalcs_with_status_date_set(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    """#1500: same recalc requirement holds when the project has an explicit
    status date — the case the CPM forward-pass floor most directly reads
    percent_complete for (remaining duration laid out from the data date)."""
    task.project.status_date = date(2026, 4, 10)
    task.project.save(update_fields=["status_date"])
    status, calls = _patch_task(
        client, task, {"percent_complete": 50}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 1


@pytest.mark.django_db
def test_notes_and_name_only_patch_still_does_not_recalc_with_status_date_set(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    """Sanity check that the #1500 fix is scoped to percent_complete: the
    genuinely inert fields stay gated even on a project with a status date."""
    task.project.status_date = date(2026, 4, 10)
    task.project.save(update_fields=["status_date"])
    status, calls = _patch_task(
        client,
        task,
        {"notes": "Some context", "name": "Renamed"},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    assert calls == 0


# ---------------------------------------------------------------------------
# Project-level scheduling inputs (#5177) and sprint start/delete (#5179)
# ---------------------------------------------------------------------------


def _call(
    client: APIClient,
    method: str,
    url: str,
    body: dict[str, object] | None,
    django_capture_on_commit_callbacks: object,
) -> tuple[int, MagicMock]:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.projects.views._dispatch_webhooks"),
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as mock_recalc,
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        r = (
            getattr(client, method)(url, body, format="json")
            if body is not None
            else getattr(client, method)(url)
        )
    return r.status_code, mock_recalc


@pytest.mark.django_db
@pytest.mark.parametrize(
    "body",
    [{"start_date": "2026-05-01"}, {"status_date": "2026-04-15"}],
)
def test_project_start_or_status_date_change_recalcs(
    client: APIClient,
    project: Project,
    body: dict[str, object],
    django_capture_on_commit_callbacks: object,
) -> None:
    status, recalc = _call(
        client, "patch", f"/api/v1/projects/{project.pk}/", body, django_capture_on_commit_callbacks
    )
    assert status == 200
    recalc.assert_called_once_with(str(project.pk), reason=ScheduleRequestReason.TASK_CHANGE)


@pytest.mark.django_db
def test_clearing_status_date_recalcs(
    client: APIClient, project: Project, django_capture_on_commit_callbacks: object
) -> None:
    project.status_date = date(2026, 4, 10)
    project.save(update_fields=["status_date"])
    status, recalc = _call(
        client,
        "patch",
        f"/api/v1/projects/{project.pk}/",
        {"status_date": None},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    recalc.assert_called_once_with(str(project.pk), reason=ScheduleRequestReason.TASK_CHANGE)


@pytest.mark.django_db
def test_project_patch_leaving_dates_unchanged_does_not_recalc(
    client: APIClient, project: Project, django_capture_on_commit_callbacks: object
) -> None:
    project.status_date = date(2026, 4, 10)
    project.save(update_fields=["status_date"])
    status, recalc = _call(
        client,
        "patch",
        f"/api/v1/projects/{project.pk}/",
        {"name": "Renamed", "start_date": "2026-04-01", "status_date": "2026-04-10"},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    recalc.assert_not_called()


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 6),
        finish_date=date(2026, 4, 20),
        state=SprintState.PLANNED,
    )


@pytest.mark.django_db
def test_planned_sprint_start_date_change_recalcs(
    client: APIClient, sprint: Sprint, django_capture_on_commit_callbacks: object
) -> None:
    status, recalc = _call(
        client,
        "patch",
        f"/api/v1/sprints/{sprint.pk}/",
        {"start_date": "2026-04-08"},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    recalc.assert_called_once_with(str(sprint.project_id), reason=ScheduleRequestReason.TASK_CHANGE)


@pytest.mark.django_db
def test_sprint_rename_does_not_recalc(
    client: APIClient, sprint: Sprint, django_capture_on_commit_callbacks: object
) -> None:
    status, recalc = _call(
        client,
        "patch",
        f"/api/v1/sprints/{sprint.pk}/",
        {"name": "Renamed"},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    recalc.assert_not_called()


@pytest.mark.django_db
def test_sprint_delete_recalcs(
    client: APIClient, sprint: Sprint, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    task.sprint = sprint
    task.save(update_fields=["sprint"])
    status, recalc = _call(
        client, "delete", f"/api/v1/sprints/{sprint.pk}/", None, django_capture_on_commit_callbacks
    )
    assert status == 204
    recalc.assert_called_once_with(str(sprint.project_id), reason=ScheduleRequestReason.TASK_CHANGE)


@pytest.mark.django_db
def test_sprint_patch_echoing_unchanged_start_date_does_not_recalc(
    client: APIClient, sprint: Sprint, django_capture_on_commit_callbacks: object
) -> None:
    status, recalc = _call(
        client,
        "patch",
        f"/api/v1/sprints/{sprint.pk}/",
        {"name": "Renamed", "start_date": "2026-04-06"},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    recalc.assert_not_called()


@pytest.mark.django_db
def test_deleting_a_sprint_with_no_tasks_also_recalcs(
    client: APIClient, sprint: Sprint, django_capture_on_commit_callbacks: object
) -> None:
    """User-accepted: the delete enqueues even when no task moved."""
    status, recalc = _call(
        client, "delete", f"/api/v1/sprints/{sprint.pk}/", None, django_capture_on_commit_callbacks
    )
    assert status == 204
    recalc.assert_called_once_with(str(sprint.project_id), reason=ScheduleRequestReason.TASK_CHANGE)


@pytest.mark.django_db
def test_calendar_and_start_date_change_enqueues_exactly_once(
    client: APIClient, project: Project, django_capture_on_commit_callbacks: object
) -> None:
    other = Calendar.objects.create(name="Other")
    status, recalc = _call(
        client,
        "patch",
        f"/api/v1/projects/{project.pk}/",
        {"calendar": str(other.pk), "start_date": "2026-05-01"},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    recalc.assert_called_once_with(str(project.pk), reason=ScheduleRequestReason.CALENDAR_CHANGE)


@pytest.fixture
def program(user: object) -> Program:
    p = Program.objects.create(name="Prog")
    ProgramMembership.objects.create(program=p, user=user, role=Role.ADMIN)
    return p


@pytest.mark.django_db
def test_program_change_recalcs(
    client: APIClient,
    project: Project,
    program: Program,
    django_capture_on_commit_callbacks: object,
) -> None:
    status, recalc = _call(
        client,
        "patch",
        f"/api/v1/projects/{project.pk}/",
        {"program": str(program.pk)},
        django_capture_on_commit_callbacks,
    )
    assert status == 200, recalc
    recalc.assert_called_once_with(str(project.pk), reason=ScheduleRequestReason.TASK_CHANGE)


@pytest.mark.django_db
def test_program_patch_to_same_program_does_not_recalc(
    client: APIClient,
    project: Project,
    program: Program,
    django_capture_on_commit_callbacks: object,
) -> None:
    project.program = program
    project.save(update_fields=["program"])
    status, recalc = _call(
        client,
        "patch",
        f"/api/v1/projects/{project.pk}/",
        {"program": str(program.pk)},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    recalc.assert_not_called()
