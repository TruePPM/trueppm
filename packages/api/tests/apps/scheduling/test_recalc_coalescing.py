"""Redundant recalculations are not queued or run (#4095).

An edit that lands while a CPM run is in flight must cost one follow-up pass, not
one pass per edit, and the stranded-PENDING recovery path (#314) must still
dispatch.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from datetime import date, timedelta
from itertools import count
from typing import Any
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest
import redis as redis_lib
from celery.exceptions import Retry, SoftTimeLimitExceeded
from django.db import InterfaceError, OperationalError
from django.utils import timezone
from trueppm_scheduler import SchedulerError, engine

from trueppm_api.apps.projects.models import Project, Task
from trueppm_api.apps.scheduling import tasks as sched_tasks
from trueppm_api.apps.scheduling.models import (
    FailedTask,
    ScheduleRequest,
    ScheduleRequestStatus,
)
from trueppm_api.apps.scheduling.services import (
    RECALC_ORPHAN_AFTER,
    claim_schedule_request,
    enqueue_recalculate,
    retire_schedule_requests,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def project() -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 1, 5))


@pytest.fixture
def delay() -> Iterator[MagicMock]:
    ids = count()
    with patch.object(
        sched_tasks.recalculate_schedule,
        "delay",
        side_effect=lambda *_: MagicMock(id=f"task-{next(ids)}"),
    ) as mock:
        yield mock


@pytest.fixture
def runs() -> Iterator[MagicMock]:
    """Count CPM passes without computing them; retire the outbox row as a pass does."""

    def _pass(project_id: str, tracker: object = None, claimed_ids: Iterable[UUID] = ()) -> bool:
        retire_schedule_requests(claimed_ids)
        return False

    with (
        patch.object(sched_tasks, "_run_schedule", side_effect=_pass) as mock,
        patch("trueppm_api.apps.taskruns.tracker.TaskRunTracker"),
    ):
        yield mock


def _statuses(project: Project) -> list[str]:
    return sorted(ScheduleRequest.objects.filter(project=project).values_list("status", flat=True))


def _execute(project: Project, **request: object) -> None:
    """Run the task body as a worker would, with the Valkey lock mocked as free."""
    task = sched_tasks.recalculate_schedule
    task.push_request(**request)
    try:
        with patch("trueppm_api.core.idempotent.valkey.client"):
            task.run(str(project.pk))
    finally:
        task.pop_request()


def test_five_edits_during_a_run_cost_one_follow_up_pass(
    project: Project, delay: MagicMock, runs: MagicMock
) -> None:
    pid = str(project.pk)
    enqueue_recalculate(pid)  # the run that will be "in flight"
    in_flight = claim_schedule_request(pid)
    assert in_flight

    for _ in range(5):
        enqueue_recalculate(pid)
    assert delay.call_count == 2, "one message for the first run, one for the follow-up"

    # The in-flight pass finishes: it retires only what it claimed.
    retire_schedule_requests(in_flight)
    # The follow-up message arrives after contending on the lock; it serves all five.
    _execute(project, id="requeued", headers={"x-requeue-count": 1})
    # The drain has nothing left, and a late duplicate message bails.
    sched_tasks._do_drain()
    _execute(project, id="requeued-again", headers={"x-requeue-count": 2})

    assert delay.call_count == 2
    assert runs.call_count == 1  # plus the in-flight pass: two executions in total
    assert _statuses(project) == ["done", "done"]


def test_stranded_pending_row_still_dispatches(project: Project, delay: MagicMock) -> None:
    """A broker outage left a PENDING row and nothing is in flight."""
    ScheduleRequest.objects.create(project=project)

    enqueue_recalculate(str(project.pk))

    delay.assert_called_once_with(str(project.pk))
    assert _statuses(project) == ["dispatched"]


def test_stale_dispatched_row_does_not_suppress_dispatch(
    project: Project, delay: MagicMock
) -> None:
    ScheduleRequest.objects.create(
        project=project,
        status=ScheduleRequestStatus.DISPATCHED,
        dispatched_at=timezone.now() - timedelta(minutes=11),
    )
    ScheduleRequest.objects.create(project=project)

    enqueue_recalculate(str(project.pk))

    delay.assert_called_once_with(str(project.pk))


def test_drain_leaves_a_pending_row_while_a_run_is_in_flight(
    project: Project, delay: MagicMock
) -> None:
    ScheduleRequest.objects.create(
        project=project,
        status=ScheduleRequestStatus.DISPATCHED,
        dispatched_at=timezone.now(),
    )
    ScheduleRequest.objects.create(project=project)

    sched_tasks._do_drain()

    delay.assert_not_called()
    assert _statuses(project) == ["dispatched", "pending"]


def test_claim_promotes_pending_and_retires_the_older_dispatched_row(project: Project) -> None:
    older = ScheduleRequest.objects.create(
        project=project,
        status=ScheduleRequestStatus.DISPATCHED,
        dispatched_at=timezone.now(),
    )
    newer = ScheduleRequest.objects.create(project=project)

    assert claim_schedule_request(str(project.pk))

    older.refresh_from_db()
    newer.refresh_from_db()
    assert older.status == ScheduleRequestStatus.DONE
    assert newer.status == ScheduleRequestStatus.DISPATCHED


def test_message_with_no_evidence_of_a_row_still_runs(project: Project, runs: MagicMock) -> None:
    """A dead-letter requeue, or a message ahead of its writer's commit, must run."""
    _execute(project, id="requeue-from-dead-letter")

    runs.assert_called_once()


def test_redelivery_of_a_finished_run_bails(project: Project, runs: MagicMock) -> None:
    ScheduleRequest.objects.create(
        project=project, status=ScheduleRequestStatus.DONE, celery_task_id="same-task"
    )

    _execute(project, id="same-task")

    runs.assert_not_called()


# ---------------------------------------------------------------------------
# Real retire code: a run settles only the rows it claimed.
# ---------------------------------------------------------------------------


@pytest.fixture
def scheduled(project: Project) -> Project:
    Task.objects.create(project=project, name="A", duration=2)
    return project


@pytest.fixture
def no_tracker() -> Iterator[None]:
    with patch("trueppm_api.apps.taskruns.tracker.TaskRunTracker"):
        yield


@contextmanager
def _during_each_pass(*actions: Callable[[], None]) -> Iterator[list[int]]:
    """Run the real engine, firing the next action after the data has been read."""
    passes: list[int] = []
    real = engine.schedule
    queue = list(actions)

    def _schedule(*args: Any, **kwargs: Any) -> Any:
        passes.append(1)
        if queue:
            queue.pop(0)()
        return real(*args, **kwargs)

    with patch.object(engine, "schedule", side_effect=_schedule):
        yield passes


def _row(project: Project, status: str, **fields: Any) -> ScheduleRequest:
    return ScheduleRequest.objects.create(project=project, status=status, **fields)


def _dispatched(project: Project, task_id: str = "m1") -> ScheduleRequest:
    return _row(
        project,
        ScheduleRequestStatus.DISPATCHED,
        dispatched_at=timezone.now(),
        celery_task_id=task_id,
    )


def test_edit_during_a_rowless_run_is_recalculated(
    scheduled: Project, delay: MagicMock, no_tracker: None
) -> None:
    pid = str(scheduled.pk)
    with _during_each_pass(lambda: enqueue_recalculate(pid)) as passes:
        _execute(scheduled, id="dead-letter-requeue")
        assert _statuses(scheduled) == ["dispatched"], "the edit's row is not the run's"
        _execute(scheduled, id="again", headers={"x-requeue-count": 1})

    assert len(passes) == 2
    assert _statuses(scheduled) == ["done"]


def test_superseded_run_does_not_retire_the_newer_row(
    scheduled: Project, delay: MagicMock, no_tracker: None
) -> None:
    pid = str(scheduled.pk)
    older = _dispatched(scheduled)

    def _edit_after_the_run_went_stale() -> None:
        ScheduleRequest.objects.filter(pk=older.pk).update(
            dispatched_at=timezone.now() - timedelta(minutes=11)
        )
        enqueue_recalculate(pid)
        sched_tasks._do_drain()  # retires the older row and dispatches the edit's
        assert _statuses(scheduled) == ["dispatched", "done"]

    with _during_each_pass(_edit_after_the_run_went_stale):
        _execute(scheduled, id="m1")

    assert _statuses(scheduled) == ["dispatched", "done"]


def test_refused_input_does_not_retire_an_edit_made_during_the_run(
    project: Project, delay: MagicMock, runs: MagicMock
) -> None:
    def _edit_then_refuse(*_: object) -> bool:
        enqueue_recalculate(str(project.pk))
        raise SchedulerError("refused")

    runs.side_effect = _edit_then_refuse

    _execute(project, id="rowless")

    assert _statuses(project) == ["dispatched"]


def test_claim_refreshes_a_row_it_only_saw(project: Project) -> None:
    old = timezone.now() - timedelta(minutes=9)
    row = _row(project, ScheduleRequestStatus.DISPATCHED, dispatched_at=old)

    assert claim_schedule_request(str(project.pk), "m9") == [row.pk]

    row.refresh_from_db()
    assert row.dispatched_at is not None and row.dispatched_at > old
    assert row.celery_task_id == "m9"


def test_redelivery_bails_when_the_worker_claimed_before_the_dispatch_was_recorded(
    project: Project, runs: MagicMock
) -> None:
    _row(project, ScheduleRequestStatus.PENDING)

    _execute(project, id="m1")
    _execute(project, id="m1")

    assert runs.call_count == 1


# ---------------------------------------------------------------------------
# No exit may strand a row DISPATCHED and hold back the next recalculation.
# ---------------------------------------------------------------------------


def _assert_drain_dispatches_the_next_edit(project: Project, delay: MagicMock) -> None:
    if not ScheduleRequest.objects.filter(project=project, status="pending").exists():
        _row(project, ScheduleRequestStatus.PENDING)
    delay.reset_mock()
    sched_tasks._do_drain()
    delay.assert_called_once_with(str(project.pk))


def test_no_committed_tasks_retires_the_row(
    project: Project, delay: MagicMock, no_tracker: None
) -> None:
    _dispatched(project)

    _execute(project, id="m1")

    _assert_drain_dispatches_the_next_edit(project, delay)


def test_missing_project_retires_the_claimed_row(project: Project) -> None:
    row = _dispatched(project)

    sched_tasks._run_schedule(str(uuid4()), None, [row.pk])

    assert _statuses(project) == ["done"]


def test_time_limit_retires_the_row_and_dead_letters(
    project: Project, delay: MagicMock, runs: MagicMock
) -> None:
    _dispatched(project)
    runs.side_effect = SoftTimeLimitExceeded()

    _execute(project, id="m1")

    assert FailedTask.objects.filter(task_id="m1").count() == 1
    _assert_drain_dispatches_the_next_edit(project, delay)


def _age_claim(project: Project, age: timedelta) -> None:
    ScheduleRequest.objects.filter(project=project, status="dispatched").update(
        dispatched_at=timezone.now() - age
    )


def _assert_recovered_only_by_the_orphan_sweep(project: Project, delay: MagicMock) -> None:
    """The work is neither lost nor handed back sooner than RECALC_ORPHAN_AFTER."""
    assert _statuses(project)[-1:] == ["dispatched"], "the claimed row must not be retired"
    delay.reset_mock()
    sched_tasks._do_drain()
    _age_claim(project, RECALC_ORPHAN_AFTER - timedelta(seconds=5))
    sched_tasks._do_drain()
    delay.assert_not_called()

    _age_claim(project, RECALC_ORPHAN_AFTER + timedelta(seconds=5))
    sched_tasks._do_drain()
    delay.assert_called_once_with(str(project.pk))


@pytest.mark.parametrize(
    "error",
    [
        InterfaceError("connection already closed"),
        redis_lib.TimeoutError("Timeout reading from socket"),
        ValueError("boom"),
    ],
    ids=["db-interface", "redis-timeout", "unknown"],
)
def test_unexpected_failure_hands_the_work_to_the_orphan_sweep(
    project: Project, delay: MagicMock, runs: MagicMock, error: Exception
) -> None:
    """An error outside the known verdicts may be transient: it must not retire the row."""
    _dispatched(project)
    runs.side_effect = error

    with pytest.raises(type(error)):
        _execute(project, id="m1")

    assert _statuses(project) != ["done"]
    _assert_recovered_only_by_the_orphan_sweep(project, delay)


def test_edit_during_an_unexpected_failure_is_recalculated(
    project: Project, delay: MagicMock, runs: MagicMock
) -> None:
    def _edit_then_fail(*_: object) -> bool:
        enqueue_recalculate(str(project.pk))
        raise InterfaceError("connection already closed")

    _dispatched(project)
    runs.side_effect = _edit_then_fail

    with pytest.raises(InterfaceError):
        _execute(project, id="m1")

    assert _statuses(project) == ["dispatched", "pending"]
    _age_claim(project, RECALC_ORPHAN_AFTER + timedelta(seconds=5))
    delay.reset_mock()
    sched_tasks._do_drain()
    delay.assert_called_once_with(str(project.pk))


def test_transient_failure_keeps_the_row_for_the_retry(project: Project, runs: MagicMock) -> None:
    row = _dispatched(project)
    runs.side_effect = OperationalError("gone")

    retry = patch.object(sched_tasks.recalculate_schedule, "retry", side_effect=Retry())
    with retry, pytest.raises(Retry):
        _execute(project, id="m1", retries=0)

    row.refresh_from_db()
    assert row.status == ScheduleRequestStatus.DISPATCHED


def test_exhausted_retries_wait_for_the_orphan_sweep_every_time(
    project: Project, delay: MagicMock, runs: MagicMock
) -> None:
    """A deterministic OperationalError (a statement timeout) must not loop on the drain."""
    _dispatched(project)
    runs.side_effect = OperationalError("canceling statement due to statement timeout")

    for attempt in range(2):
        with pytest.raises(OperationalError):
            _execute(project, id=f"m{attempt}", retries=3, called_directly=False)
        # The sweep's re-dispatch is the message the next attempt delivers.
        _assert_recovered_only_by_the_orphan_sweep(project, delay)

    assert runs.call_count == 2


def _drop(project: Project, **request: Any) -> None:
    """Deliver a message whose re-queue budget is spent while the lock is held."""
    task = sched_tasks.recalculate_schedule
    task.push_request(**request)
    try:
        with patch("trueppm_api.core.idempotent.valkey.client") as client:
            client.return_value.set.return_value = None
            task.run(str(project.pk))
    finally:
        task.pop_request()


def test_dropped_message_releases_its_row(project: Project, delay: MagicMock) -> None:
    _dispatched(project, "m1")

    _drop(project, id="m1-requeue-5", headers={"x-requeue-count": 5, "x-origin-task-id": "m1"})

    assert _statuses(project) == ["done", "pending"]
    _assert_drain_dispatches_the_next_edit(project, delay)


def test_dropped_message_leaves_another_runs_row_alone(project: Project) -> None:
    _dispatched(project, "the-running-one")

    _drop(project, id="m2", headers={"x-requeue-count": 5})

    assert _statuses(project) == ["dispatched"]
