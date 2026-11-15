"""A phase's ``status`` is materialized from its leaves (#3531, ADR-0293).

``phase_status_rollup_locked`` promised a rollup that nothing wrote, so a phase sat at
``NOT_STARTED`` forever and every reader of the stored field (``is_blocked``, SPI)
treated a finished phase as unstarted. These tests pin the derivation table, the
write-back on both CPM paths, ``own_status`` isolation, and the consumers that flip.
"""

from __future__ import annotations

import datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

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


def _run(project: Project) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))


@pytest.mark.django_db
def test_backlog_flip_schedules_one_followup_and_settles_in_it(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """A phase leaving BACKLOG is excluded from the pass that un-BACKLOGs it (#3531).

    CPM inputs drop BACKLOG rows, so the pass that flips the phase out of BACKLOG
    still ran without it: no dates, successor not pushed. The rollup must schedule
    exactly one follow-up recompute, and that follow-up must settle the network and
    must not enqueue another (the rollup is idempotent).
    """
    phase = _t(project, "1")
    leaf = _t(project, "1.1", S.BACKLOG)
    succ = _t(project, "2")
    Dependency.objects.create(predecessor=phase, successor=succ)

    enqueue = MagicMock()
    with patch("trueppm_api.apps.scheduling.services.enqueue_recalculate", enqueue):
        with django_capture_on_commit_callbacks(execute=True):
            _run(project)  # phase -> BACKLOG (entering BACKLOG is a flip too)
        phase.refresh_from_db()
        assert phase.status == S.BACKLOG
        assert enqueue.call_count == 1
        enqueue.reset_mock()
        with django_capture_on_commit_callbacks(execute=True):
            _run(project)  # the follow-up for the flip above: nothing changes
        assert enqueue.call_count == 0

        Task.objects.filter(pk=leaf.pk).update(status=S.NOT_STARTED)
        with django_capture_on_commit_callbacks(execute=True):
            _run(project)  # phase leaves BACKLOG here, but this pass excluded it
        phase.refresh_from_db()
        assert phase.status == S.NOT_STARTED
        assert enqueue.call_count == 1
        enqueue.assert_called_once_with(str(project.pk))
        enqueue.reset_mock()

        with django_capture_on_commit_callbacks(execute=True):
            _run(project)  # the single follow-up: settles, and does not loop
        assert enqueue.call_count == 0

    phase.refresh_from_db()
    succ.refresh_from_db()
    assert phase.early_start is not None and phase.early_finish is not None
    assert succ.early_start is not None and succ.early_start >= phase.early_finish


@pytest.mark.django_db
def test_rollup_bumps_sync_cursor_for_changed_phases_only(project: Project) -> None:
    phase = _t(project, "1")
    _t(project, "1.1", S.COMPLETE)
    untouched = _t(project, "2")
    _t(project, "2.1", S.NOT_STARTED)
    before = (phase.server_version, phase.sync_seq, untouched.server_version, untouched.sync_seq)

    rollup_phase_statuses([project.pk])

    phase.refresh_from_db()
    untouched.refresh_from_db()
    assert phase.server_version == before[0] + 1
    assert phase.sync_seq > before[1]
    assert (untouched.server_version, untouched.sync_seq) == before[2:]


@pytest.mark.django_db
def test_program_pass_rolls_up_member_phase_status(db: object) -> None:
    from trueppm_api.apps.projects.models import Program
    from trueppm_api.apps.scheduling.tasks import _run_program_schedule

    program = Program.objects.create(name="P")
    proj = Project.objects.create(
        name="M",
        start_date=datetime.date(2026, 1, 5),
        calendar=Calendar.objects.create(name="C2"),
        program=program,
    )
    phase = _t(proj, "1")
    _t(proj, "1.1", S.COMPLETE)
    _t(proj, "1.2", S.COMPLETE)
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_program_schedule(str(program.pk))
    phase.refresh_from_db()
    assert phase.status == S.COMPLETE


@pytest.mark.django_db
def test_status_source_and_invariants_in_task_payload(project: Project) -> None:
    from trueppm_api.apps.projects.models import StructureRole
    from trueppm_api.apps.projects.serializers import TaskSerializer
    from trueppm_api.apps.projects.views import annotate_tasks_queryset

    done = _t(project, "1", percent_complete=0)
    _t(project, "1.1", S.COMPLETE, percent_complete=100)
    _t(project, "1.2", S.COMPLETE, percent_complete=100)
    idle = _t(project, "3")
    _t(project, "3.1", S.NOT_STARTED, percent_complete=0)
    empty = _t(project, "2", structure_role=StructureRole.CONTAINER)
    leaf = _t(project, "4")
    rollup_phase_statuses([project.pk])
    rows = {
        t.pk: TaskSerializer(t).data
        for t in annotate_tasks_queryset(Task.objects.filter(project=project))
    }
    assert rows[done.pk]["status_source"] == "derived"
    assert rows[done.pk]["status_rollup_count"] == 2
    assert rows[empty.pk]["status_source"] == "none"
    assert rows[leaf.pk]["status_source"] == "committed"
    assert rows[idle.pk]["status_source"] == "derived"
    # issue invariants: COMPLETE implies 100, NOT_STARTED implies 0.
    for t in Task.objects.filter(project=project, pk__in=[done.pk, idle.pk]):
        pct = rows[t.pk]["percent_complete"]
        if t.status == S.COMPLETE:
            assert pct == 100
        if t.status == S.NOT_STARTED:
            assert pct == 0


@pytest.mark.django_db
def test_backlog_phase_is_not_a_product_backlog_story(project: Project) -> None:
    """A phase of all-BACKLOG leaves stores BACKLOG; it must not rank as a story (#3531)."""
    from trueppm_api.apps.projects.product_backlog_services import _backlog_stories

    phase = _t(project, "1")
    leaf = _t(project, "1.1", S.BACKLOG)
    rollup_phase_statuses([project.pk])
    phase.refresh_from_db()
    assert phase.status == S.BACKLOG
    assert [t.pk for t in _backlog_stories(project)] == [leaf.pk]


@pytest.mark.django_db
def test_in_pass_rollup_bumps_sync_cursor(project: Project) -> None:
    phase = _t(project, "1")
    _t(project, "1.1", S.COMPLETE)
    before = (phase.server_version, phase.sync_seq)
    _run(project)
    phase.refresh_from_db()
    assert phase.status == S.COMPLETE
    assert phase.server_version == before[0] + 1 and phase.sync_seq > before[1]


@pytest.mark.django_db
def test_real_enqueue_followup_settles_the_network(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Same flip, but through the real enqueue path and the real recompute task."""
    from trueppm_api.apps.scheduling.models import ScheduleRequest

    phase = _t(project, "1")
    leaf = _t(project, "1.1", S.BACKLOG)
    succ = _t(project, "2")
    Dependency.objects.create(predecessor=phase, successor=succ)
    _run(project)  # phase enters BACKLOG
    Task.objects.filter(pk=leaf.pk).update(status=S.NOT_STARTED)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay") as delay:
        delay.return_value.id = "00000000-0000-0000-0000-000000000001"
        with django_capture_on_commit_callbacks(execute=True):
            _run(project)
    delay.assert_called_once_with(str(project.pk))
    assert ScheduleRequest.objects.filter(project=project).exists()

    _run(project)  # what the dispatched task runs
    phase.refresh_from_db()
    succ.refresh_from_db()
    assert phase.early_start is not None and phase.early_finish is not None
    assert succ.early_start >= phase.early_finish


@pytest.mark.django_db
def test_program_pass_enqueues_once_per_flipped_member(
    db: object, django_capture_on_commit_callbacks: Any
) -> None:
    from trueppm_api.apps.projects.models import Program
    from trueppm_api.apps.scheduling.tasks import _run_program_schedule

    program = Program.objects.create(name="P2")
    members = []
    for i in range(2):
        proj = Project.objects.create(
            name=f"M{i}",
            start_date=datetime.date(2026, 1, 5),
            calendar=Calendar.objects.create(name=f"CM{i}"),
            program=program,
        )
        _t(proj, "1")
        _t(proj, "1.1", S.BACKLOG)
        members.append(proj)
    enqueue = MagicMock()
    with (
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate", enqueue),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        _run_program_schedule(str(program.pk))
    assert sorted(c.args[0] for c in enqueue.call_args_list) == sorted(str(m.pk) for m in members)


@pytest.mark.django_db
def test_cpm_complete_tells_peers_to_reread_when_phase_status_moves(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """No per-task delta carries status, so cpm_complete must say tasks are stale."""
    _t(project, "1")
    _t(project, "1.1", S.COMPLETE)
    events: list[tuple[str, dict[str, Any]]] = []

    def _capture(*, project_id: str, event_type: str, payload: dict[str, Any], **_: Any) -> None:
        events.append((event_type, payload))

    def _go() -> None:
        events.clear()
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", _capture),
            patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
            django_capture_on_commit_callbacks(execute=True),
        ):
            _run_schedule(str(project.pk))

    _go()
    assert next(p for e, p in events if e == "cpm_complete").get("dates_changed") is True
    _go()  # nothing moves now
    assert "dates_changed" not in next(p for e, p in events if e == "cpm_complete")


@pytest.mark.django_db
def test_phase_containers_are_not_wip_or_remaining_flow_items(project: Project) -> None:
    from trueppm_api.apps.projects.services import annotate_wip_breach, throughput_forecast

    _t(project, "1")
    _t(project, "1.1", S.IN_PROGRESS)
    rollup_phase_statuses([project.pk])  # phase now IN_PROGRESS too
    col = annotate_wip_breach(project.pk, [{"status": "IN_PROGRESS", "wip_limit": 1}])[0]
    assert col["current_count"] == 1  # the leaf only

    with patch(
        "trueppm_api.apps.projects.services._project_weekly_throughput",
        return_value=([{"completed_count": 3}] * 4, None),
    ):
        out = throughput_forecast(project.pk)
    assert out is not None and out["remaining_count"] == 1
