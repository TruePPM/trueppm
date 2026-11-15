"""A phase's ``status`` is materialized from its leaves (#3531, ADR-0293).

``phase_status_rollup_locked`` promised a rollup that nothing wrote, so a phase sat at
``NOT_STARTED`` forever and every reader of the stored field (``is_blocked``, SPI)
treated a finished phase as unstarted. These tests pin the derivation table, the
write-back on both CPM paths, ``own_status`` isolation, and the consumers that flip.
"""

from __future__ import annotations

import datetime
from unittest.mock import patch

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Dependency,
    Project,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.program_rollup import spi_counts_by_project
from trueppm_api.apps.scheduling.services import derive_phase_status, rollup_phase_statuses
from trueppm_api.apps.scheduling.tasks import _run_schedule

S = TaskStatus
TODAY = datetime.date(2026, 3, 2)


@pytest.mark.parametrize(
    ("leaves", "expected"),
    [
        ([], None),
        ([S.BACKLOG, S.BACKLOG], S.BACKLOG),
        ([S.COMPLETE, S.COMPLETE], S.COMPLETE),
        ([S.COMPLETE, S.BACKLOG], S.COMPLETE),  # backlog leaves leave the pool
        ([S.COMPLETE, S.REVIEW], S.REVIEW),
        ([S.REVIEW, S.REVIEW], S.REVIEW),
        ([S.COMPLETE, S.REVIEW, S.NOT_STARTED], S.IN_PROGRESS),
        ([S.IN_PROGRESS, S.NOT_STARTED], S.IN_PROGRESS),
        ([S.COMPLETE, S.NOT_STARTED], S.IN_PROGRESS),  # rule 5: some done, none underway
        ([S.NOT_STARTED, S.NOT_STARTED, S.BACKLOG], S.NOT_STARTED),
    ],
)
def test_derivation_table(leaves: list[str], expected: str | None) -> None:
    assert derive_phase_status(leaves) == expected


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(
        name="PhaseRollup",
        start_date=datetime.date(2026, 1, 5),
        calendar=Calendar.objects.create(name="C"),
    )


def _t(project: Project, path: str, status: str = S.NOT_STARTED, **kw: object) -> Task:
    return Task.objects.create(
        project=project, name=f"T{path}", duration=2, wbs_path=path, status=status, **kw
    )


@pytest.mark.django_db
def test_rollup_writes_status_at_any_depth_and_never_own_status(project: Project) -> None:
    root = _t(project, "1", own_status=S.IN_PROGRESS)
    mid = _t(project, "1.1")
    _t(project, "1.1.1", S.COMPLETE)
    _t(project, "1.1.2", S.COMPLETE)
    _t(project, "1.2", S.COMPLETE)
    empty = _t(project, "2")  # declared container with no children: untouched

    changed = rollup_phase_statuses([project.pk])

    root.refresh_from_db()
    mid.refresh_from_db()
    empty.refresh_from_db()
    assert changed == 2
    assert mid.status == S.COMPLETE and root.status == S.COMPLETE
    assert root.own_status == S.IN_PROGRESS  # parked authored value never overwritten
    assert empty.status == S.NOT_STARTED
    assert rollup_phase_statuses([project.pk]) == 0  # idempotent


@pytest.mark.django_db
def test_subtasks_are_not_leaves(project: Project) -> None:
    phase = _t(project, "1")
    _t(project, "1.1", S.NOT_STARTED)
    Task.objects.create(
        project=project,
        name="chk",
        duration=1,
        wbs_path="1.1.1",
        is_subtask=True,
        status=S.COMPLETE,
    )
    rollup_phase_statuses([project.pk])
    phase.refresh_from_db()
    assert phase.status == S.NOT_STARTED


@pytest.mark.django_db
def test_cpm_recompute_writes_phase_status_and_unblocks_successor(project: Project) -> None:
    phase = _t(project, "1")
    _t(project, "1.1", S.COMPLETE)
    _t(project, "1.2", S.COMPLETE)
    succ = _t(project, "2")
    Dependency.objects.create(predecessor=phase, successor=succ)

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))

    phase.refresh_from_db()
    assert phase.status == S.COMPLETE

    from trueppm_api.apps.projects.views import annotate_tasks_queryset

    row = annotate_tasks_queryset(Task.objects.filter(pk__in=[succ.pk, phase.pk])).get(pk=succ.pk)
    assert row.is_blocked is False  # the transition: was blocked forever before #3531
    prow = annotate_tasks_queryset(Task.objects.filter(pk=phase.pk)).get()
    assert prow.status_rollup_count == 2


@pytest.mark.django_db
def test_spi_baseline_path_excludes_phase_rows(project: Project) -> None:
    phase = _t(project, "1", S.COMPLETE, early_finish=TODAY, actual_finish=TODAY)
    leaf = _t(project, "1.1", S.COMPLETE, early_finish=TODAY, actual_finish=TODAY)
    late = _t(project, "1.2", S.IN_PROGRESS, early_finish=TODAY)
    baseline = Baseline.objects.create(
        project=project, name="B", is_active=True, has_cpm_dates=True
    )
    for t in (phase, leaf, late):
        BaselineTask.objects.create(
            baseline=baseline, task_id=t.pk, task_name=t.name, finish=TODAY, duration=1
        )
    assert spi_counts_by_project([project.pk], TODAY)[project.pk] == (2, 1)
    _ = timezone.now()
