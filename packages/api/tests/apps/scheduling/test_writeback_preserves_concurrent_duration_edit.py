"""A CPM write-back must not revert a leaf ``duration`` committed while it ran (#4371).

The recalc loads every task at T0 and persists at T1 with ``bulk_update``. Nothing
locks the rows or checks ``server_version`` in between, so any column in that
``bulk_update`` field list is written back with its T0 value. For the engine-owned
outputs (early/late dates, floats, ``is_critical`` …) that is harmless: the edit
that raced the recalc also enqueued a follow-up recalc, which recomputes them. For
``duration`` on a leaf it is a silent lost update: ``duration`` is a user INPUT the
engine does not compute, the follow-up recalc reads the reverted value as truth,
and ``bulk_update`` allocates no ``sync_seq``, so no client is ever told.

Each test injects the concurrent edit at the last point before the write-back
transaction (``_build_schedule_shift_events`` runs after the load and before the
``atomic`` block on both passes), commits it the way a PATCH does — through
``Model.save()``, which bumps ``server_version`` — and asserts the stored value
survives. ``transaction=True`` so the edit genuinely commits rather than sharing the
test's wrapping transaction.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import date
from typing import Any
from unittest import mock

import pytest
from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    STRUCTURE_SHADOW_RESTORE_FIELDS,
    Calendar,
    Dependency,
    Program,
    Project,
    StructureRole,
    Task,
    TaskStatus,
    structural_parent,
    sync_structure_shadow_values,
)
from trueppm_api.apps.scheduling import tasks as sched_tasks

MONDAY = date(2026, 1, 5)


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


def _commit_duration_edit(task_id: object, duration: int) -> int:
    """Commit a duration edit the way a PATCH does, returning the new server_version."""
    row = Task.objects.get(pk=task_id)
    row.duration = duration
    row.save()
    row.refresh_from_db()
    return int(row.server_version)


@pytest.fixture
def during_recalc() -> Iterator[Callable[[Callable[[], Any]], list[Any]]]:
    """Arm a one-shot callable to run between the recalc's load and its write-back."""
    real = sched_tasks._build_schedule_shift_events
    armed: list[Callable[[], Any]] = []
    results: list[Any] = []

    def _wrapped(*args: Any, **kwargs: Any) -> Any:
        if armed:
            results.append(armed.pop()())
        return real(*args, **kwargs)

    def _arm(fn: Callable[[], Any]) -> list[Any]:
        armed.append(fn)
        return results

    with mock.patch.object(sched_tasks, "_build_schedule_shift_events", side_effect=_wrapped):
        yield _arm


@pytest.fixture
def edit_during_recalc(
    during_recalc: Callable[[Callable[[], Any]], list[Any]],
) -> Callable[[object, int], list[Any]]:
    """Arm a one-shot concurrent duration edit between load and write-back."""

    def _arm(task_id: object, duration: int) -> list[Any]:
        return during_recalc(lambda: _commit_duration_edit(task_id, duration))

    return _arm


@pytest.fixture
def broadcasts() -> Iterator[list[tuple[str, str, dict[str, Any]]]]:
    """Record every board broadcast the recalc fires on commit."""
    sent: list[tuple[str, str, dict[str, Any]]] = []

    def _record(project_id: str, event_type: str, payload: dict[str, Any]) -> None:
        sent.append((str(project_id), event_type, payload))

    with mock.patch(
        "trueppm_api.apps.sync.broadcast.broadcast_board_event",
        side_effect=lambda *a, **kw: _record(
            kw.get("project_id", a[0] if a else ""),
            kw.get("event_type", a[1] if len(a) > 1 else ""),
            kw.get("payload", a[2] if len(a) > 2 else {}),
        ),
    ):
        yield sent


def _delta_row(
    sent: list[tuple[str, str, dict[str, Any]]], task_id: object
) -> dict[str, Any] | None:
    for _pid, event, payload in sent:
        if event != "task_dates_updated":
            continue
        for row in payload.get("tasks", []):
            if row["id"] == str(task_id):
                return dict(row)
    return None


def _remove_last_child(child_id: object) -> None:
    """Delete a container's last child the way ``TaskViewSet.perform_destroy`` does.

    The accidental container reverts to work and gets its parked estimate back, saved
    through ``Model.save()`` — the restore the recalc must not overwrite.
    """
    # One transaction, as the request runs under ATOMIC_REQUESTS.
    with transaction.atomic():
        child = Task.objects.get(pk=child_id)
        parent = structural_parent(child)
        child.soft_delete()
        assert parent is not None
        parent.refresh_from_db()
        assert sync_structure_shadow_values(parent), "fixture premise: the container reverts"
        parent.save(update_fields=list(STRUCTURE_SHADOW_RESTORE_FIELDS))


@pytest.mark.django_db(transaction=True)
class TestSingleProjectWriteBack:
    def test_leaf_duration_edited_mid_recalc_survives(
        self, calendar: Calendar, edit_during_recalc: Callable[[object, int], list[Any]]
    ) -> None:
        project = Project.objects.create(
            name="Race", start_date=MONDAY, status_date=MONDAY, calendar=calendar
        )
        phase = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
        leaf = Task.objects.create(project=project, name="Work", duration=5, wbs_path="1.1")

        versions = edit_during_recalc(leaf.pk, 8)
        sched_tasks._run_schedule(str(project.pk), tracker=None)

        assert versions, "fixture premise: the concurrent edit must have run mid-recalc"
        leaf.refresh_from_db()
        assert leaf.duration == 8
        # The PATCH's version bump is not undone either — the row the client holds
        # and the row the DB holds describe the same edit.
        assert leaf.server_version == versions[0]
        # Summary durations are still written: the phase was rolled up from the
        # T0 snapshot (5 working days), proving the summary write-back still runs.
        phase.refresh_from_db()
        assert phase.duration == 5

    def test_summary_duration_still_written(self, calendar: Calendar) -> None:
        """Regression: excluding leaves must not stop the #3530 summary write-back."""
        project = Project.objects.create(
            name="Summary", start_date=MONDAY, status_date=MONDAY, calendar=calendar
        )
        phase = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
        leaf = Task.objects.create(project=project, name="Work", duration=10, wbs_path="1.1")

        sched_tasks._run_schedule(str(project.pk), tracker=None)

        phase.refresh_from_db()
        leaf.refresh_from_db()
        assert phase.duration == 10
        assert leaf.duration == 10
        # The CPM outputs on the leaf are still persisted alongside.
        assert leaf.early_start == MONDAY
        assert leaf.early_finish == date(2026, 1, 16)

    def test_container_that_lost_its_last_child_keeps_its_restored_estimate(
        self, calendar: Calendar, during_recalc: Callable[[Callable[[], Any]], list[Any]]
    ) -> None:
        """A summary at load time that stopped being one before the write (#4371).

        Deleting an accidental container's last child restores its parked estimate
        into ``duration``. The recalc still holds the row as a summary; writing the
        rolled-up span over the restore would be permanent, because the next recalc
        reads the row as a leaf and never writes its duration again.
        """
        project = Project.objects.create(
            name="Revert", start_date=MONDAY, status_date=MONDAY, calendar=calendar
        )
        parent = Task.objects.create(
            project=project,
            name="Was work",
            duration=3,
            wbs_path="1",
            structure_role=StructureRole.CONTAINER,
            auto_container=True,
            own_estimate=3,
            own_status=TaskStatus.NOT_STARTED,
        )
        child = Task.objects.create(project=project, name="Child", duration=10, wbs_path="1.1")

        ran = during_recalc(lambda: _remove_last_child(child.pk))
        sched_tasks._run_schedule(str(project.pk), tracker=None)

        assert ran, "fixture premise: the child removal must have run mid-recalc"
        parent.refresh_from_db()
        assert parent.auto_container is False
        assert parent.duration == 3

    def test_delta_broadcast_carries_the_committed_duration(
        self,
        calendar: Calendar,
        edit_during_recalc: Callable[[object, int], list[Any]],
        broadcasts: list[tuple[str, str, dict[str, Any]]],
    ) -> None:
        """The ``task_dates_updated`` row a client splices must not undo the PATCH."""
        project = Project.objects.create(
            name="Delta", start_date=MONDAY, status_date=MONDAY, calendar=calendar
        )
        leaf = Task.objects.create(project=project, name="Work", duration=5, wbs_path="1")

        edit_during_recalc(leaf.pk, 8)
        sched_tasks._run_schedule(str(project.pk), tracker=None)

        row = _delta_row(broadcasts, leaf.pk)
        assert row is not None, "fixture premise: the leaf moved and was broadcast"
        assert row["duration"] == 8


@pytest.mark.django_db(transaction=True)
class TestProgramWriteBack:
    def _program(self, calendar: Calendar) -> tuple[Program, Task, Task, Task]:
        program = Program.objects.create(name="Migration")
        proj_a = Project.objects.create(
            name="A", start_date=MONDAY, status_date=MONDAY, calendar=calendar, program=program
        )
        proj_b = Project.objects.create(
            name="B", start_date=MONDAY, status_date=MONDAY, calendar=calendar, program=program
        )
        phase_a = Task.objects.create(project=proj_a, name="Assess", duration=1, wbs_path="1")
        a_leaf = Task.objects.create(project=proj_a, name="Survey", duration=10, wbs_path="1.1")
        Task.objects.create(project=proj_b, name="Cutover", duration=1, wbs_path="1")
        b_leaf = Task.objects.create(project=proj_b, name="Switch", duration=4, wbs_path="1.1")
        Dependency.objects.create(
            predecessor=a_leaf,
            successor=b_leaf,
            dep_type="FS",
            lag=0,
            pending_acceptance=False,
            accepted_at=timezone.now(),
        )
        return program, phase_a, a_leaf, b_leaf

    def test_leaf_duration_edited_mid_program_pass_survives(
        self, calendar: Calendar, edit_during_recalc: Callable[[object, int], list[Any]]
    ) -> None:
        program, phase_a, _a_leaf, b_leaf = self._program(calendar)

        versions = edit_during_recalc(b_leaf.pk, 9)
        sched_tasks._run_program_schedule(str(program.pk))

        assert versions, "fixture premise: the concurrent edit must have run mid-recalc"
        b_leaf.refresh_from_db()
        assert b_leaf.duration == 9
        assert b_leaf.server_version == versions[0]
        phase_a.refresh_from_db()
        assert phase_a.duration == 10

    def test_summary_duration_still_written_by_program_pass(self, calendar: Calendar) -> None:
        program, phase_a, a_leaf, _b_leaf = self._program(calendar)

        sched_tasks._run_program_schedule(str(program.pk))

        phase_a.refresh_from_db()
        a_leaf.refresh_from_db()
        assert phase_a.duration == 10
        assert a_leaf.duration == 10
        assert a_leaf.early_finish == date(2026, 1, 16)

    def test_program_delta_broadcast_carries_the_committed_duration(
        self,
        calendar: Calendar,
        edit_during_recalc: Callable[[object, int], list[Any]],
        broadcasts: list[tuple[str, str, dict[str, Any]]],
    ) -> None:
        program, _phase_a, _a_leaf, b_leaf = self._program(calendar)

        edit_during_recalc(b_leaf.pk, 9)
        sched_tasks._run_program_schedule(str(program.pk))

        row = _delta_row(broadcasts, b_leaf.pk)
        assert row is not None, "fixture premise: the leaf moved and was broadcast"
        assert row["duration"] == 9
