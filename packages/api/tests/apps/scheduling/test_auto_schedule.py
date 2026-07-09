"""Tests for the auto-scheduling Celery task and trigger endpoint."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Sprint, SprintState, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="sched_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Sched", start_date=date(2026, 1, 5), calendar=calendar)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T1", duration=3)


@pytest.fixture
def scheduler_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Task create triggers recalculate_schedule.delay
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_task_create_triggers_schedule(user: object, project: Project, calendar: Calendar) -> None:
    """Creating a Task via the API enqueues recalculate_schedule for its project."""
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_result = MagicMock()
        mock_result.id = "mock-celery-id"
        mock_task.delay = MagicMock(return_value=mock_result)
        resp = c.post(
            "/api/v1/tasks/",
            {"project": str(project.pk), "name": "Build", "duration": 2},
        )
        assert resp.status_code == 201
        mock_task.delay.assert_called_once_with(str(project.pk))


@pytest.mark.django_db(transaction=True)
def test_task_delete_triggers_schedule(user: object, project: Project, task: Task) -> None:
    """Deleting a Task via the API enqueues recalculate_schedule."""
    # Role.ADMIN required: IsProjectMemberWriteOrOwn blocks MEMBER on unassigned tasks.
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_result = MagicMock()
        mock_result.id = "mock-celery-id"
        mock_task.delay = MagicMock(return_value=mock_result)
        resp = c.delete(f"/api/v1/tasks/{task.pk}/")
        assert resp.status_code == 204
        mock_task.delay.assert_called_once_with(str(project.pk))


# ---------------------------------------------------------------------------
# Redis idempotency lock — collision causes re-queue
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_schedule_lock_collision_requeues(project: Project) -> None:
    """When the Redis lock is already held, the task re-queues itself."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    mock_redis = MagicMock()
    # SET NX returns None (falsy) when lock is already held.
    mock_redis.set.return_value = None

    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch.object(recalculate_schedule, "apply_async") as mock_apply,
    ):
        mock_redis_module.from_url.return_value = mock_redis

        # Call the task's run() method directly so self=recalculate_schedule
        # (the Celery task instance), which is what bind=True provides at runtime.
        # patch.object above intercepts self.apply_async inside the function body.
        recalculate_schedule.run(str(project.pk))

        mock_apply.assert_called_once_with(
            args=[str(project.pk)],
            kwargs={},
            countdown=10,
            headers={"x-requeue-count": 1},
        )


@pytest.mark.django_db
def test_successful_recalc_stamps_recalculated_at(project: Project, task: Task) -> None:
    """A successful CPM pass stamps recalculated_at — the signal the web Schedule
    view's "recalculating" badge clears against (#1053). Acquire the lock so the
    task body runs through to the post-_run_schedule stamp."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    assert project.recalculated_at is None

    mock_redis = MagicMock()
    # SET NX returns truthy → lock acquired, task body executes.
    mock_redis.set.return_value = "OK"

    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        mock_redis_module.from_url.return_value = mock_redis
        recalculate_schedule.run(str(project.pk))

    project.refresh_from_db()
    assert project.recalculated_at is not None


@pytest.mark.django_db
def test_completed_task_without_actuals_keeps_full_span(project: Project) -> None:
    """End-to-end (builder -> engine -> bulk_update): a 100%-complete task with no
    actual dates must keep its full-duration bar, not collapse to early_start ==
    early_finish (the 1-day-bar bug, ADR-0136)."""
    from trueppm_api.apps.projects.models import TaskStatus
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    # A 5-working-day task marked complete with no actuals (the seed/contributor
    # state). Project starts Mon 2026-01-05.
    done = Task.objects.create(
        project=project,
        name="Done",
        duration=5,
        status=TaskStatus.COMPLETE,
        percent_complete=100.0,
    )

    mock_redis = MagicMock()
    mock_redis.set.return_value = "OK"  # lock acquired → task body runs
    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        mock_redis_module.from_url.return_value = mock_redis
        recalculate_schedule.run(str(project.pk))

    done.refresh_from_db()
    assert done.early_start is not None and done.early_finish is not None
    assert done.early_start != done.early_finish  # not collapsed to a single day
    # Mon 2026-01-05 .. Fri 2026-01-09 is five working days (four calendar days apart).
    assert done.early_start == date(2026, 1, 5)
    assert done.early_finish == date(2026, 1, 9)


# ---------------------------------------------------------------------------
# Reason plumbing (#355) — outbox row must record what triggered the recalc
# so "why did this fire?" debugging doesn't require correlating timestamps.
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_dependency_create_records_dependency_change_reason(
    user: object, project: Project, task: Task
) -> None:
    """Creating a Dependency via the API tags the outbox row as DEPENDENCY_CHANGE."""
    from trueppm_api.apps.projects.models import Dependency
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

    Dependency.objects.all().delete()  # ensure a clean slate
    ScheduleRequest.objects.all().delete()

    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=user)
    successor = Task.objects.create(project=project, name="T2", duration=2)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        resp = c.post(
            "/api/v1/dependencies/",
            {"predecessor": str(task.pk), "successor": str(successor.pk), "dep_type": "FS"},
        )
        assert resp.status_code == 201

    req = ScheduleRequest.objects.get(project=project)
    assert req.reason == ScheduleRequestReason.DEPENDENCY_CHANGE


@pytest.mark.django_db(transaction=True)
def test_manual_trigger_records_manual_reason(user: object, project: Project) -> None:
    """The manual /schedule/ endpoint tags the outbox row as MANUAL."""
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

    ScheduleRequest.objects.all().delete()
    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        resp = c.post(f"/api/v1/projects/{project.pk}/schedule/")
        assert resp.status_code == 202

    req = ScheduleRequest.objects.get(project=project)
    assert req.reason == ScheduleRequestReason.MANUAL


@pytest.mark.django_db(transaction=True)
def test_task_create_records_task_change_reason(
    user: object, project: Project, calendar: Calendar
) -> None:
    """Creating a Task (non-dependency edit) keeps the default TASK_CHANGE reason."""
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

    ScheduleRequest.objects.all().delete()
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        resp = c.post(
            "/api/v1/tasks/",
            {"project": str(project.pk), "name": "Build", "duration": 2},
        )
        assert resp.status_code == 201

    req = ScheduleRequest.objects.get(project=project)
    assert req.reason == ScheduleRequestReason.TASK_CHANGE


@pytest.mark.django_db(transaction=True)
def test_project_calendar_change_enqueues_recalc(
    user: object, project: Project, calendar: Calendar
) -> None:
    """Swapping a project's working calendar enqueues a CALENDAR_CHANGE recompute.

    CPM lag is calendar-aware, so the calendar is a scheduling input — editing it
    must trigger a recalculation (#1267). The calendar is an Admin-only general
    setting, so the caller holds ADMIN.
    """
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

    ScheduleRequest.objects.all().delete()
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    other_calendar = Calendar.objects.create(name="Four-Day Week")
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        resp = c.patch(
            f"/api/v1/projects/{project.pk}/",
            {"calendar": str(other_calendar.pk)},
        )
        assert resp.status_code == 200

    req = ScheduleRequest.objects.get(project=project)
    assert req.reason == ScheduleRequestReason.CALENDAR_CHANGE


@pytest.mark.django_db(transaction=True)
def test_project_update_without_calendar_change_does_not_enqueue(
    user: object, project: Project, calendar: Calendar
) -> None:
    """A project edit that leaves the calendar unchanged enqueues no recompute.

    Guards against re-running CPM on every project-settings save — only a genuine
    calendar swap is a scheduling-input change (#1267).
    """
    from trueppm_api.apps.scheduling.models import ScheduleRequest

    ScheduleRequest.objects.all().delete()
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        # Re-submit the same calendar alongside a name edit: calendar_id is
        # unchanged, so the guard must skip the enqueue.
        resp = c.patch(
            f"/api/v1/projects/{project.pk}/",
            {"name": "Renamed", "calendar": str(calendar.pk)},
        )
        assert resp.status_code == 200

    assert ScheduleRequest.objects.filter(project=project).count() == 0


# ---------------------------------------------------------------------------
# Manual trigger endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_trigger_endpoint_requires_scheduler_role(user: object, project: Project) -> None:
    """A Member cannot trigger the schedule endpoint."""
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    resp = c.post(f"/api/v1/projects/{project.pk}/schedule/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_trigger_endpoint_enqueues_task(scheduler_client: APIClient, project: Project) -> None:
    """A Scheduler-role user can trigger the schedule endpoint."""
    with patch(
        "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
        return_value=MagicMock(id="test-celery-id"),
    ):
        resp = scheduler_client.post(f"/api/v1/projects/{project.pk}/schedule/")
    assert resp.status_code == 202
    assert resp.data == {"queued": True}


@pytest.mark.django_db
def test_trigger_endpoint_404_for_missing_project(scheduler_client: APIClient) -> None:
    import uuid

    fake_pk = uuid.uuid4()
    resp = scheduler_client.post(f"/api/v1/projects/{fake_pk}/schedule/")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_writeback_passes_batch_size() -> None:
    """The CPM writeback must chunk ``bulk_update`` via ``batch_size`` (#1529).

    Rationale for asserting on the kwarg rather than SQL/timing: on PostgreSQL an
    unbatched ``bulk_update`` emits a single UPDATE with per-field ``CASE WHEN``
    chains regardless of row count, so neither query count nor a tiny fixture's
    wall-clock reveals whether batching is wired. Dropping ``batch_size`` would
    silently reintroduce the multi-MB single-statement pathology with no other
    signal. We spy on the call — the same idiom the incremental benchmark uses to
    lock perf behavior that is invisible to ``CaptureQueriesContext``.
    """
    from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
    from trueppm_api.apps.scheduling.tasks import _WRITEBACK_BATCH_SIZE, _run_schedule

    original_bulk_update = Task.objects.bulk_update
    seen_batch_sizes: list[int | None] = []

    def spy_bulk_update(objs, fields, *args, **kwargs):  # type: ignore[no-untyped-def]
        seen_batch_sizes.append(kwargs.get("batch_size"))
        return original_bulk_update(objs, fields, *args, **kwargs)

    cal = Calendar.objects.create(name="Batch")
    proj = Project.objects.create(name="BatchProj", start_date=date(2026, 1, 5), calendar=cal)
    a = Task.objects.create(project=proj, name="A", duration=2)
    b = Task.objects.create(project=proj, name="B", duration=2)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
        patch.object(Task.objects, "bulk_update", side_effect=spy_bulk_update),
    ):
        _run_schedule(str(proj.pk))

    assert seen_batch_sizes, "Task.objects.bulk_update was never called"
    assert all(bs == _WRITEBACK_BATCH_SIZE for bs in seen_batch_sizes), (
        f"CPM writeback called bulk_update with batch_size={seen_batch_sizes}; "
        f"expected every call to pass {_WRITEBACK_BATCH_SIZE}. A missing batch_size "
        f"reintroduces the single giant-UPDATE pathology (#1529)."
    )


# ---------------------------------------------------------------------------
# Sprint-window SNET floor end-to-end (ADR-0168, #1284): a sprint-assigned task
# with no planned_start positions in its sprint window, not the project origin.
# ---------------------------------------------------------------------------


def _run_recalc(project: Project) -> None:
    """Run recalculate_schedule end-to-end with the idempotency lock acquired and
    the side-effecting broadcasts/webhooks patched out (mirrors the completed-task
    span test above)."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    mock_redis = MagicMock()
    mock_redis.set.return_value = "OK"  # lock acquired → task body runs
    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        mock_redis_module.from_url.return_value = mock_redis
        recalculate_schedule.run(str(project.pk))


def _active_sprint(project: Project, start: date, finish: date) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S",
        start_date=start,
        finish_date=finish,
        state=SprintState.ACTIVE,
    )


@pytest.mark.django_db
def test_sprint_assigned_task_floors_at_sprint_start(project: Project) -> None:
    """A sprint-assigned task with no planned_start positions at its sprint start
    (project starts Mon 2026-01-05; the sprint starts four weeks later)."""
    sprint = _active_sprint(project, date(2026, 2, 2), date(2026, 2, 13))
    story = Task.objects.create(project=project, name="Story", duration=3, sprint=sprint)

    _run_recalc(project)

    story.refresh_from_db()
    # Floored at the sprint start (Mon 2026-02-02), not the project origin.
    assert story.early_start == date(2026, 2, 2)
    # Three working days: 02-02, 02-03, 02-04.
    assert story.early_finish == date(2026, 2, 4)
    # The floor is engine input only — the stored field stays null (ADR-0168).
    assert story.planned_start is None


@pytest.mark.django_db
def test_task_without_sprint_still_floors_at_project_start(project: Project) -> None:
    """Regression guard: the floor only applies to sprint-assigned tasks; a loose
    task with no planned_start still floors at the project start."""
    loose = Task.objects.create(project=project, name="Loose", duration=3)

    _run_recalc(project)

    loose.refresh_from_db()
    assert loose.early_start == date(2026, 1, 5)


@pytest.mark.django_db
def test_dependency_later_than_sprint_floor_wins(project: Project) -> None:
    """A predecessor that finishes after the sprint start pushes the successor past
    its sprint floor — the existing max(es_constraints) resolves precedence."""
    from trueppm_api.apps.projects.models import Dependency

    sprint = _active_sprint(project, date(2026, 2, 2), date(2026, 2, 13))
    # Predecessor pinned far past the sprint: Mon 2026-03-02 + 2 wd → ends Tue 03-03.
    pred = Task.objects.create(
        project=project, name="Pred", duration=2, planned_start=date(2026, 3, 2)
    )
    succ = Task.objects.create(project=project, name="Succ", duration=3, sprint=sprint)
    Dependency.objects.create(predecessor=pred, successor=succ, dep_type="FS", lag=0)

    _run_recalc(project)

    succ.refresh_from_db()
    # max(sprint floor 02-02, pred finish 03-03 + 1 wd = 03-04) → the dependency wins.
    assert succ.early_start == date(2026, 3, 4)


@pytest.mark.django_db
def test_sprint_milestone_not_floored_at_sprint_start(project: Project) -> None:
    """A milestone is excluded from the sprint floor (a sprint review/demo gate
    belongs at the sprint end, ADR-0106) — it floors at the project start instead."""
    sprint = _active_sprint(project, date(2026, 2, 2), date(2026, 2, 13))
    ms = Task.objects.create(project=project, name="Demo", is_milestone=True, sprint=sprint)

    _run_recalc(project)

    ms.refresh_from_db()
    assert ms.early_start == date(2026, 1, 5)


@pytest.mark.django_db
def test_backlog_and_soft_deleted_tasks_are_excluded_from_cpm(project: Project) -> None:
    """The deterministic CPM feed must match CommittedTaskManager: BACKLOG cards and
    soft-deleted tombstones are not scheduled, so grooming the backlog cannot move
    the critical path and the two forecasts cannot structurally disagree (#1772)."""
    from trueppm_api.apps.projects.models import TaskStatus
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    committed = Task.objects.create(
        project=project, name="Committed", duration=3, status=TaskStatus.NOT_STARTED
    )
    backlog = Task.objects.create(
        project=project, name="Backlog idea", duration=3, status=TaskStatus.BACKLOG
    )
    deleted = Task.objects.create(
        project=project, name="Deleted", duration=3, status=TaskStatus.NOT_STARTED
    )
    deleted.soft_delete()

    mock_redis = MagicMock()
    mock_redis.set.return_value = "OK"  # lock acquired → task body runs
    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        mock_redis_module.from_url.return_value = mock_redis
        recalculate_schedule.run(str(project.pk))

    committed.refresh_from_db()
    backlog.refresh_from_db()
    deleted.refresh_from_db()

    # The committed task is scheduled from the project start.
    assert committed.early_start == date(2026, 1, 5)
    # BACKLOG and soft-deleted rows are never admitted to the network, so CPM never
    # stamps early/late dates on them.
    assert backlog.early_start is None and backlog.early_finish is None
    assert deleted.early_start is None and deleted.early_finish is None
