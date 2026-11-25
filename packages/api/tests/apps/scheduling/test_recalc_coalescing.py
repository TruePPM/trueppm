"""Redundant recalculations are not queued or run (#4095).

An edit that lands while a CPM run is in flight must cost one follow-up pass, not
one pass per edit, and the stranded-PENDING recovery path (#314) must still
dispatch.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date, timedelta
from itertools import count
from unittest.mock import MagicMock, patch

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.scheduling import tasks as sched_tasks
from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus
from trueppm_api.apps.scheduling.services import claim_schedule_request, enqueue_recalculate

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

    def _pass(project_id: str, tracker: object = None) -> bool:
        ScheduleRequest.objects.filter(
            project_id=project_id, status=ScheduleRequestStatus.DISPATCHED
        ).update(status=ScheduleRequestStatus.DONE)
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
    assert claim_schedule_request(pid)

    for _ in range(5):
        enqueue_recalculate(pid)
    assert delay.call_count == 2, "one message for the first run, one for the follow-up"

    # The in-flight pass finishes: it retires only what it claimed.
    ScheduleRequest.objects.filter(project=project, status=ScheduleRequestStatus.DISPATCHED).update(
        status=ScheduleRequestStatus.DONE
    )
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
