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


@pytest.mark.django_db
def test_update_does_not_fail_a_run_adopted_after_selection(project: Project) -> None:
    from trueppm_api.apps.taskruns.tasks import _fail_if_still_stale

    run = _run(project, TaskRunStatus.PENDING, OLD)
    cutoff = timezone.now() - timedelta(seconds=450)
    # A worker adopts the run between the sweep's select and its update.
    TaskRun.objects.filter(pk=run.pk).update(
        status=TaskRunStatus.RUNNING, started_at=timezone.now()
    )
    n = _fail_if_still_stale(run.pk, cutoff, timezone.now(), "simulation_abandoned", "d", {})
    assert n == 0
    run.refresh_from_db()
    assert run.status == TaskRunStatus.RUNNING


@pytest.mark.django_db
def test_late_worker_exit_does_not_overwrite_a_reaped_run(project: Project) -> None:
    from unittest.mock import MagicMock

    from trueppm_api.apps.taskruns.tracker import TaskRunTracker

    run = _run(project, TaskRunStatus.RUNNING, OLD)
    tracker = TaskRunTracker(MagicMock(), project_id=str(project.pk), task_name="x")
    tracker._task_run_id = str(run.pk)
    assert _do_reap_stale_task_runs() == 1
    tracker.set_result({"ok": True})
    assert tracker.__exit__(None, None, None) is False
    run.refresh_from_db()
    assert run.status == TaskRunStatus.FAILED
    assert run.result_summary["error"] == "simulation_abandoned"


@pytest.mark.django_db
def test_unresolvable_reapable_task_logs_a_warning(
    project: Project, caplog: pytest.LogCaptureFixture
) -> None:
    from unittest.mock import patch

    from trueppm_api.apps.taskruns import tasks

    with (
        patch.dict(tasks._REAPABLE, {"scheduling.monte_carlo": ("no.such.task", "task_abandoned")}),
        caplog.at_level("WARNING"),
    ):
        _do_reap_stale_task_runs()
    assert "no registered Celery task 'no.such.task'" in caplog.text
