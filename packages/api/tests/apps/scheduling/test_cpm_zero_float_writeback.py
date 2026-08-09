"""Zero float must persist as ``0``, never NULL (#2802).

``_apply_cpm_results`` used to convert the engine's ``timedelta`` floats with a
truthiness test, and ``bool(timedelta(0)) is False`` — so the one value that
defines a critical-path task was written as NULL. That blanked the Float cell on
exactly the tasks a PM inspects, and made ``capture_forecast_snapshot``'s
``Min("total_float")`` skip every critical task, reporting the project's tightest
slack as the smallest *positive* float on the plan.

NULL still means "not scheduled"; ``0`` means "no slack". These tests pin the
distinction on the write-back and on the snapshot it feeds.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.models import ForecastSnapshotTrigger
from trueppm_api.apps.scheduling.services import capture_forecast_snapshot
from trueppm_api.apps.scheduling.tasks import _run_schedule


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="StdZeroFloat")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="ZeroFloatProj",
        start_date=date(2026, 1, 5),  # Monday
        calendar=calendar,
    )


def _recompute(project: Project) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))


@pytest.mark.django_db
def test_critical_chain_persists_zero_total_float_not_null(project: Project) -> None:
    # A → B → C with nothing else in the plan: every task is critical, so every
    # task's total float is exactly zero.
    a = Task.objects.create(project=project, name="A", duration=3)
    b = Task.objects.create(project=project, name="B", duration=2)
    c = Task.objects.create(project=project, name="C", duration=4)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")
    Dependency.objects.create(predecessor=b, successor=c, dep_type="FS")

    _recompute(project)

    for task in (a, b, c):
        task.refresh_from_db()
        assert task.is_critical is True, f"{task.name} should be on the critical path"
        assert task.total_float is not None, f"{task.name} zero float persisted as NULL"
        assert task.total_float == 0


@pytest.mark.django_db
def test_zero_slack_driving_predecessor_persists_zero_free_float(project: Project) -> None:
    # A(5) and B(3) both feed C. A finishes last, so A drives C and has zero free
    # float; B can slip and carries positive float. The discriminating case: A's
    # 0 and B's non-zero must both round-trip, and A's must not become NULL.
    a = Task.objects.create(project=project, name="A", duration=5)
    b = Task.objects.create(project=project, name="B", duration=3)
    c = Task.objects.create(project=project, name="C", duration=2)
    ac = Dependency.objects.create(predecessor=a, successor=c, dep_type="FS")
    Dependency.objects.create(predecessor=b, successor=c, dep_type="FS")

    _recompute(project)

    a.refresh_from_db()
    b.refresh_from_db()
    ac.refresh_from_db()
    assert ac.is_driving is True, "A drives C — it pins C's early start"
    assert a.free_float is not None, "driving predecessor's zero free float persisted as NULL"
    assert a.free_float == 0
    assert a.total_float == 0
    # The slack arm is unaffected — it was never at risk, and stays positive.
    assert b.free_float is not None
    assert b.free_float > 0


@pytest.mark.django_db
def test_unscheduled_task_still_persists_null_float(project: Project) -> None:
    # NULL keeps its distinct meaning: a task the engine never returned results
    # for has no float at all, which is not the same fact as "no slack".
    orphan = Task.objects.create(project=project, name="Orphan", duration=2, total_float=None)
    assert orphan.total_float is None


@pytest.mark.django_db
def test_forecast_snapshot_reports_zero_slack_when_a_critical_path_exists(
    project: Project,
) -> None:
    # A → B is the critical chain (float 0); D hangs off nothing and floats free.
    # Min("total_float") skips NULLs, so before the fix the snapshot reported D's
    # positive float as the project's tightest slack — a healthier number than
    # reality.
    a = Task.objects.create(project=project, name="A", duration=10)
    b = Task.objects.create(project=project, name="B", duration=10)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")
    Task.objects.create(project=project, name="D", duration=1)

    _recompute(project)

    snap = capture_forecast_snapshot(project.pk, ForecastSnapshotTrigger.RECOMPUTE)
    assert snap is not None
    assert snap.total_float_days is not None, "critical path reported no slack figure at all"
    assert snap.total_float_days == 0
