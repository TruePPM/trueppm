"""Sprint close drain — outbox semantics, idempotency, ScheduleRequest emission."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintCloseRequest,
    SprintCloseRequestStatus,
    SprintState,
    SprintTaskDisposition,
    SprintTaskOutcome,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.tasks import _do_drain, close_sprint
from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

User = get_user_model()


@pytest.fixture(autouse=True)
def _mock_redis_lock() -> object:
    """Bypass the Redis SET NX lock so idempotent_task wrappers run inline.

    The lock_extender thread is also short-circuited — its EXTEND/RELEASE
    Lua scripts hit the same mocked client and return acquired/released.
    """
    mock_client = MagicMock()
    mock_client.set.return_value = True  # SET NX succeeded — we own the lock
    mock_client.register_script.return_value = MagicMock(return_value=1)
    with patch("trueppm_api.core.idempotent.redis_lib") as redis_module:
        redis_module.from_url.return_value = mock_client
        yield mock_client


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="closer", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


def _make_active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=10,
        committed_task_count=3,
    )


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_sprint_completes_request(_broadcast: object, user: object, project: Project) -> None:
    s = _make_active_sprint(project)
    Task.objects.create(
        project=project,
        name="Done",
        duration=1,
        sprint=s,
        story_points=5,
        status=TaskStatus.COMPLETE,
    )
    Task.objects.create(
        project=project,
        name="Open",
        duration=1,
        sprint=s,
        story_points=5,
        status=TaskStatus.IN_PROGRESS,
    )
    req = SprintCloseRequest.objects.create(sprint=s, requested_by=user, carry_over_to="backlog")

    close_sprint.run(str(req.id))

    req.refresh_from_db()
    s.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.COMPLETED
    assert s.state == SprintState.COMPLETED
    assert s.completed_points == 5
    assert s.completed_task_count == 1
    assert s.closed_at is not None
    # Carry-over moved the open task back to backlog
    open_task = Task.objects.get(name="Open")
    assert open_task.sprint_id is None
    assert open_task.status == TaskStatus.BACKLOG


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_clears_sprint_rank_on_live_rows_and_preserves_in_history(
    _broadcast: object, user: object, project: Project
) -> None:
    """#365: sprint close clears sprint_rank on every live row (the task returns to
    the product backlog ordered by priority_rank), while the closing rank is preserved
    on the HistoricalTask written by the clear save()."""
    s = _make_active_sprint(project)
    done = Task.objects.create(
        project=project,
        name="Done",
        duration=1,
        sprint=s,
        story_points=5,
        status=TaskStatus.COMPLETE,
        sprint_rank=1,
    )
    carried = Task.objects.create(
        project=project,
        name="Carried",
        duration=1,
        sprint=s,
        story_points=5,
        status=TaskStatus.IN_PROGRESS,
        sprint_rank=2,
    )

    req = SprintCloseRequest.objects.create(sprint=s, requested_by=user, carry_over_to="backlog")
    close_sprint.run(str(req.id))

    done.refresh_from_db()
    carried.refresh_from_db()
    # Live rows: sprint_rank cleared. The completed task stays in the sprint; the
    # incomplete one is carried to the backlog — both lose their execution rank.
    assert done.sprint_rank is None
    assert carried.sprint_rank is None
    assert carried.sprint_id is None
    # The closing rank survives on history for forensic/HistoricalTask reads.
    assert done.history.filter(sprint_rank=1).exists()
    assert carried.history.filter(sprint_rank=2).exists()


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_sprint_emits_schedule_request_with_sprint_closed_reason(
    _broadcast: object, project: Project
) -> None:
    s = _make_active_sprint(project)
    req = SprintCloseRequest.objects.create(sprint=s)
    close_sprint.run(str(req.id))
    sr = ScheduleRequest.objects.filter(project=project).first()
    assert sr is not None
    assert sr.reason == ScheduleRequestReason.SPRINT_CLOSED


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_sprint_idempotent_on_already_completed(_broadcast: object, project: Project) -> None:
    s = Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.COMPLETED,
        closed_at=timezone.now(),
    )
    req = SprintCloseRequest.objects.create(sprint=s)
    close_sprint.run(str(req.id))
    req.refresh_from_db()
    # Short-circuited: marked completed without changing the sprint.
    assert req.status == SprintCloseRequestStatus.COMPLETED


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_sprint_carry_over_to_other_sprint(_broadcast: object, project: Project) -> None:
    s = _make_active_sprint(project)
    target = Sprint.objects.create(
        project=project,
        name="Next",
        start_date=date(2026, 5, 1),
        finish_date=date(2026, 5, 14),
        state=SprintState.PLANNED,
    )
    Task.objects.create(
        project=project,
        name="Open",
        duration=1,
        sprint=s,
        status=TaskStatus.IN_PROGRESS,
    )
    req = SprintCloseRequest.objects.create(sprint=s, carry_over_to=str(target.pk))
    close_sprint.run(str(req.id))
    moved = Task.objects.get(name="Open")
    assert moved.sprint_id == target.pk


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_sprint_failed_for_cancelled(_broadcast: object, project: Project) -> None:
    s = Sprint.objects.create(
        project=project,
        name="X",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.CANCELLED,
    )
    req = SprintCloseRequest.objects.create(sprint=s)
    close_sprint.run(str(req.id))
    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.FAILED
    assert "cancelled" in req.error_message.lower()


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_carry_over_to_backlog_bumps_server_version(
    _broadcast: object, user: object, project: Project
) -> None:
    """queryset.update() skips VersionedModel.save() — mobile sync never sees the move (#396)."""
    s = _make_active_sprint(project)
    task = Task.objects.create(
        project=project,
        name="Carry",
        duration=1,
        sprint=s,
        status=TaskStatus.IN_PROGRESS,
    )
    version_before = task.server_version

    req = SprintCloseRequest.objects.create(sprint=s, requested_by=user, carry_over_to="backlog")
    close_sprint.run(str(req.id))

    task.refresh_from_db()
    assert task.sprint is None
    assert task.status == TaskStatus.BACKLOG
    assert task.server_version > version_before, (
        "server_version must be incremented so mobile sync clients see the carry-over"
    )


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_carry_over_to_next_sprint_bumps_server_version(
    _broadcast: object, project: Project
) -> None:
    """server_version bump required when moving tasks to next sprint (#396)."""
    s = _make_active_sprint(project)
    target = Sprint.objects.create(
        project=project,
        name="Next",
        start_date=date(2026, 5, 1),
        finish_date=date(2026, 5, 14),
        state=SprintState.PLANNED,
    )
    task = Task.objects.create(
        project=project,
        name="MovedTask",
        duration=1,
        sprint=s,
        status=TaskStatus.IN_PROGRESS,
    )
    version_before = task.server_version

    req = SprintCloseRequest.objects.create(sprint=s, carry_over_to=str(target.pk))
    close_sprint.run(str(req.id))

    task.refresh_from_db()
    assert task.sprint_id == target.pk
    assert task.server_version > version_before


def test_apply_carry_over_returns_moved_task_ids(project: Project) -> None:
    """close_sprint broadcasts these IDs in a tasks_bulk_mutated event so clients
    update the carried-over rows without a manual refetch."""
    from trueppm_api.apps.projects.services import apply_carry_over

    s = _make_active_sprint(project)
    t1 = Task.objects.create(
        project=project, name="A", duration=1, sprint=s, status=TaskStatus.IN_PROGRESS
    )
    t2 = Task.objects.create(
        project=project, name="B", duration=1, sprint=s, status=TaskStatus.IN_PROGRESS
    )

    moved = apply_carry_over(s, "backlog")

    assert set(moved) == {str(t1.pk), str(t2.pk)}


def test_apply_carry_over_none_returns_empty(project: Project) -> None:
    from trueppm_api.apps.projects.services import apply_carry_over

    s = _make_active_sprint(project)
    Task.objects.create(
        project=project, name="A", duration=1, sprint=s, status=TaskStatus.IN_PROGRESS
    )

    assert apply_carry_over(s, "none") == []


# ---------------------------------------------------------------------------
# SprintTaskOutcome — membership-at-close capture (ADR-0111, #982)
# ---------------------------------------------------------------------------


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_records_task_outcomes_that_survive_carry_over(
    _broadcast: object, user: object, project: Project
) -> None:
    """The closing membership set is recorded and survives the FK move (#982)."""
    s = _make_active_sprint(project)
    done = Task.objects.create(
        project=project,
        name="Done",
        duration=1,
        sprint=s,
        story_points=5,
        status=TaskStatus.COMPLETE,
    )
    Task.objects.create(
        project=project,
        name="Open",
        duration=1,
        sprint=s,
        story_points=3,
        status=TaskStatus.IN_PROGRESS,
    )
    req = SprintCloseRequest.objects.create(sprint=s, requested_by=user, carry_over_to="backlog")
    close_sprint.run(str(req.id))

    rows = {r.task_title: r for r in SprintTaskOutcome.objects.filter(sprint=s)}
    assert set(rows) == {"Done", "Open"}
    # Outcome rows persist even though the open task moved off the sprint.
    assert Task.objects.get(name="Open").sprint_id is None
    assert rows["Done"].disposition == SprintTaskDisposition.COMPLETED
    assert rows["Done"].final_status == TaskStatus.COMPLETE
    # Dropped to backlog under the "backlog" policy.
    assert rows["Open"].disposition == SprintTaskDisposition.DROPPED
    assert rows["Open"].next_sprint_id is None
    assert rows["Open"].final_status == TaskStatus.IN_PROGRESS
    # Denormalized identity captured.
    assert rows["Open"].story_points == 3
    assert rows["Open"].task_short_id.startswith("T-")
    assert rows["Open"].task_id == Task.objects.get(name="Open").id
    assert rows["Done"].task_id == done.id


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_outcome_carried_to_next_sprint_records_next_sprint(
    _broadcast: object, project: Project
) -> None:
    s = _make_active_sprint(project)
    target = Sprint.objects.create(
        project=project,
        name="Next",
        start_date=date(2026, 5, 1),
        finish_date=date(2026, 5, 14),
        state=SprintState.PLANNED,
    )
    Task.objects.create(
        project=project,
        name="Open",
        duration=1,
        sprint=s,
        status=TaskStatus.REVIEW,
    )
    req = SprintCloseRequest.objects.create(sprint=s, carry_over_to=str(target.pk))
    close_sprint.run(str(req.id))

    row = SprintTaskOutcome.objects.get(sprint=s, task_title="Open")
    assert row.disposition == SprintTaskDisposition.CARRIED
    assert row.next_sprint_id == target.pk


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_outcome_on_hold_is_dropped_not_carried(_broadcast: object, project: Project) -> None:
    """ON_HOLD is outside the carry-over filter, so it stays in the sprint and is
    recorded as dropped even under a sprint-target policy (faithful to apply_carry_over)."""
    s = _make_active_sprint(project)
    target = Sprint.objects.create(
        project=project,
        name="Next",
        start_date=date(2026, 5, 1),
        finish_date=date(2026, 5, 14),
        state=SprintState.PLANNED,
    )
    Task.objects.create(
        project=project,
        name="Held",
        duration=1,
        sprint=s,
        status=TaskStatus.ON_HOLD,
    )
    req = SprintCloseRequest.objects.create(sprint=s, carry_over_to=str(target.pk))
    close_sprint.run(str(req.id))

    row = SprintTaskOutcome.objects.get(sprint=s, task_title="Held")
    assert row.disposition == SprintTaskDisposition.DROPPED
    assert row.next_sprint_id is None
    # And apply_carry_over left it in the closed sprint.
    assert Task.objects.get(name="Held").sprint_id == s.pk


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_outcome_captures_was_pending(_broadcast: object, project: Project) -> None:
    s = _make_active_sprint(project)
    Task.objects.create(
        project=project,
        name="Injected",
        duration=1,
        sprint=s,
        status=TaskStatus.IN_PROGRESS,
        sprint_pending=True,
    )
    req = SprintCloseRequest.objects.create(sprint=s, carry_over_to="none")
    close_sprint.run(str(req.id))
    row = SprintTaskOutcome.objects.get(sprint=s, task_title="Injected")
    assert row.was_pending is True
    # "none" leaves it in the sprint; recorded as dropped (not carried forward).
    assert row.disposition == SprintTaskDisposition.DROPPED


def test_snapshot_outcomes_is_idempotent(project: Project) -> None:
    """A re-drain must not duplicate rows (bulk_create ignore_conflicts on the
    (sprint, task) unique constraint)."""
    from trueppm_api.apps.projects.services import snapshot_sprint_task_outcomes

    s = _make_active_sprint(project)
    Task.objects.create(
        project=project, name="A", duration=1, sprint=s, status=TaskStatus.IN_PROGRESS
    )
    Task.objects.create(project=project, name="B", duration=1, sprint=s, status=TaskStatus.COMPLETE)
    snapshot_sprint_task_outcomes(s, carry_over_to="backlog")
    snapshot_sprint_task_outcomes(s, carry_over_to="backlog")
    assert SprintTaskOutcome.objects.filter(sprint=s).count() == 2


# ---------------------------------------------------------------------------
# goal_outcome defaulted at close (#983)
# ---------------------------------------------------------------------------


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_goal_outcome_met_at_close(_broadcast: object, project: Project) -> None:
    s = _make_active_sprint(project)  # committed_points=10
    Task.objects.create(
        project=project, name="D", duration=1, sprint=s, story_points=8, status=TaskStatus.COMPLETE
    )
    req = SprintCloseRequest.objects.create(sprint=s, carry_over_to="backlog")
    close_sprint.run(str(req.id))
    s.refresh_from_db()
    assert s.completed_points == 8  # 8/10 = 0.8
    assert s.goal_outcome == "MET"


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_goal_outcome_missed_at_close(_broadcast: object, project: Project) -> None:
    s = _make_active_sprint(project)  # committed_points=10
    Task.objects.create(
        project=project, name="D", duration=1, sprint=s, story_points=2, status=TaskStatus.COMPLETE
    )
    req = SprintCloseRequest.objects.create(sprint=s, carry_over_to="backlog")
    close_sprint.run(str(req.id))
    s.refresh_from_db()
    assert s.goal_outcome == "MISSED"  # 2/10 = 0.2


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_goal_outcome_null_without_commitment_baseline(
    _broadcast: object, project: Project
) -> None:
    s = Sprint.objects.create(
        project=project,
        name="NoBaseline",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=0,
    )
    req = SprintCloseRequest.objects.create(sprint=s, carry_over_to="backlog")
    close_sprint.run(str(req.id))
    s.refresh_from_db()
    assert s.goal_outcome is None


@patch("trueppm_api.apps.projects.tasks.close_sprint.delay")
def test_drain_dispatches_pending_rows(mock_delay: object, project: Project) -> None:
    s = _make_active_sprint(project)
    req = SprintCloseRequest.objects.create(sprint=s)
    # Push requested_at backward to clear the >2 s minimum age filter.
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        requested_at=timezone.now() - timedelta(seconds=10)
    )
    _do_drain()
    assert mock_delay.called  # type: ignore[attr-defined]


@patch("trueppm_api.apps.projects.tasks.close_sprint.delay")
def test_drain_recovers_orphaned_in_flight(mock_delay: object, project: Project) -> None:
    s = _make_active_sprint(project)
    req = SprintCloseRequest.objects.create(sprint=s)
    # Mark IN_FLIGHT in the past — must be older than 5-minute orphan window.
    long_ago = timezone.now() - timedelta(minutes=10)
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        status=SprintCloseRequestStatus.IN_FLIGHT,
        started_at=long_ago,
        requested_at=long_ago,
    )
    _do_drain()
    req.refresh_from_db()
    # Recovery path: row is reset to PENDING; subsequent drain dispatches it.
    assert req.status == SprintCloseRequestStatus.PENDING
