"""Stale task-run sweep (#5068)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus
from trueppm_api.apps.taskruns.tasks import _do_reap_stale_task_runs

# scheduling.run_monte_carlo_simulation time_limit (330) + default margin (120) = 450.
OLD = timedelta(seconds=600)
FRESH = timedelta(seconds=60)


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="Reap", start_date=date(2026, 1, 1), calendar=cal)


def _run(project: Project, status: str, age: timedelta, name: str = "scheduling.monte_carlo"):
    run = TaskRun.objects.create(task_name=name, celery_task_id="c", project=project, status=status)
    when = timezone.now() - age
    TaskRun.objects.filter(pk=run.pk).update(
        created_at=when, started_at=when if status == TaskRunStatus.RUNNING else None
    )
    return run


@pytest.mark.django_db
def test_reaps_stale_running_and_pending(project: Project) -> None:
    running = _run(project, TaskRunStatus.RUNNING, OLD)
    pending = _run(project, TaskRunStatus.PENDING, OLD)
    assert _do_reap_stale_task_runs() == 2
    for run in (running, pending):
        run.refresh_from_db()
        assert run.status == TaskRunStatus.FAILED
        assert run.completed_at is not None
        assert run.result_summary["error"] == "simulation_abandoned"
        assert run.result_summary["status_code"] == 503


@pytest.mark.django_db
def test_leaves_fresh_terminal_and_unknown_runs_alone(project: Project) -> None:
    fresh = _run(project, TaskRunStatus.RUNNING, FRESH)
    done = _run(project, TaskRunStatus.SUCCESS, OLD)
    unknown = _run(project, TaskRunStatus.RUNNING, OLD, name="test.unregistered")
    assert _do_reap_stale_task_runs() == 0
    for run, expected in (
        (fresh, TaskRunStatus.RUNNING),
        (done, TaskRunStatus.SUCCESS),
        (unknown, TaskRunStatus.RUNNING),
    ):
        run.refresh_from_db()
        assert run.status == expected


@pytest.mark.django_db
def test_sweep_is_idempotent(project: Project) -> None:
    _run(project, TaskRunStatus.RUNNING, OLD)
    assert _do_reap_stale_task_runs() == 1
    assert _do_reap_stale_task_runs() == 0


@pytest.mark.django_db
def test_other_task_types_use_their_own_limit(project: Project) -> None:
    # recalculate time_limit is 600 s: 600 s old is inside limit + margin, 800 s is not.
    inside = _run(project, TaskRunStatus.RUNNING, OLD, name="scheduling.recalculate")
    outside = _run(
        project, TaskRunStatus.RUNNING, timedelta(seconds=800), name="scheduling.recalculate"
    )
    assert _do_reap_stale_task_runs() == 1
    inside.refresh_from_db()
    outside.refresh_from_db()
    assert inside.status == TaskRunStatus.RUNNING
    assert outside.status == TaskRunStatus.FAILED
    assert outside.result_summary["error"] == "task_abandoned"


@pytest.mark.django_db
def test_run_finished_by_worker_is_not_overwritten(project: Project) -> None:
    run = _run(project, TaskRunStatus.RUNNING, OLD)
    TaskRun.objects.filter(pk=run.pk).update(status=TaskRunStatus.SUCCESS)
    assert _do_reap_stale_task_runs() == 0
    run.refresh_from_db()
    assert run.status == TaskRunStatus.SUCCESS


@pytest.mark.django_db(transaction=True)
def test_reap_broadcasts_task_run_failed_without_detail(project: Project) -> None:
    from unittest.mock import patch

    run = _run(project, TaskRunStatus.RUNNING, OLD)
    with patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event") as bc:
        assert _do_reap_stale_task_runs() == 1
    kwargs = bc.call_args.kwargs
    assert kwargs["event_type"] == "task_run_failed"
    assert kwargs["payload"]["task_run_id"] == str(run.pk)
    assert "abandoned" not in kwargs["payload"]["error_detail"]
