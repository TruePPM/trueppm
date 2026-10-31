"""A queued task whose project was deleted exits cleanly (#4751).

Before the fix, ``TaskRunTracker.__enter__`` inserted a ``TaskRun`` with a dangling
``project_id`` and the task died with a raw FK ``IntegrityError``.
"""

from __future__ import annotations

import base64
import uuid
from datetime import date
from unittest.mock import MagicMock, patch

import pytest

from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus
from trueppm_api.apps.taskruns.tracker import (
    TaskRunProjectGone,
    TaskRunTracker,
)


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Gone", start_date=date(2026, 1, 1), calendar=cal)


def _celery_task() -> MagicMock:
    t = MagicMock()
    t.name = "test.task"
    t.request.id = "cid"
    return t


@pytest.mark.django_db
def test_tracker_raises_project_gone_for_missing_project() -> None:
    with (
        pytest.raises(TaskRunProjectGone),
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event") as bc,
        TaskRunTracker(_celery_task(), project_id=str(uuid.uuid4()), task_name="t"),
    ):
        pytest.fail("body must not run")  # pragma: no cover
    assert TaskRun.objects.count() == 0
    bc.assert_not_called()


# transaction=True: Django's FK constraints are DEFERRABLE INITIALLY DEFERRED, so inside
# a wrapping test transaction the violation would never surface at the insert.
@pytest.mark.django_db(transaction=True)
def test_tracker_translates_fk_race_between_check_and_insert(project: Project) -> None:
    """Project deleted after the existence check passes: still no raw IntegrityError."""
    pid = str(project.pk)
    real = TaskRunTracker._project_exists
    calls = {"n": 0}

    def exists_then_delete(self: TaskRunTracker) -> bool:
        calls["n"] += 1
        result = real(self)
        if calls["n"] == 1:
            Project.objects.filter(pk=pid).delete()  # the race window
        return result

    with (
        patch.object(TaskRunTracker, "_project_exists", exists_then_delete),
        pytest.raises(TaskRunProjectGone),
        TaskRunTracker(_celery_task(), project_id=pid, task_name="t"),
    ):
        pytest.fail("body must not run")  # pragma: no cover
    assert TaskRun.objects.count() == 0


@pytest.mark.django_db
def test_tracker_unchanged_for_existing_project(project: Project) -> None:
    with (
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event"),
        TaskRunTracker(_celery_task(), project_id=str(project.pk), task_name="t") as tr,
    ):
        assert tr.task_run_id is not None
    assert TaskRun.objects.get(pk=tr.task_run_id).status == TaskRunStatus.SUCCESS


@pytest.mark.django_db
def test_recalculate_schedule_deleted_project_exits_cleanly(
    caplog: pytest.LogCaptureFixture,
) -> None:
    from trueppm_api.apps.scheduling.models import FailedTask
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    mock_redis = MagicMock()
    mock_redis.set.return_value = True  # lock acquired
    with (
        caplog.at_level("INFO"),
        patch("trueppm_api.core.idempotent.valkey") as valkey,
        patch.object(recalculate_schedule, "apply_async") as retry,
    ):
        valkey.client.return_value = mock_redis
        result = recalculate_schedule.run(str(uuid.uuid4()))

    assert result is None
    retry.assert_not_called()
    assert TaskRun.objects.count() == 0
    assert FailedTask.objects.count() == 0
    assert sum("no longer exists" in r.getMessage() for r in caplog.records) == 1


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("module", "name", "extra"),
    [
        ("trueppm_api.apps.msproject.tasks", "import_msproject", {"filename": "a.xml"}),
        ("trueppm_api.apps.jiraimport.tasks", "import_jira", {"filename": "a.xml"}),
        ("trueppm_api.apps.csvimport.tasks", "import_csv", {"filename": "a.csv"}),
    ],
)
def test_import_tasks_deleted_project_skip_cleanly(
    module: str, name: str, extra: dict[str, str]
) -> None:
    import importlib

    task = getattr(importlib.import_module(module), name)
    result = task.apply(
        kwargs={
            "project_id": str(uuid.uuid4()),
            "file_content_b64": base64.b64encode(b"x").decode("ascii"),
            **extra,
        },
        throw=True,
    ).get()
    assert result == {"skipped": True, "reason": "project_deleted"}
    assert TaskRun.objects.count() == 0
