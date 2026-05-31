"""Cascade regression: a chained FS dependency edit must shift every downstream
task's CPM dates and must drive the corresponding ScheduleRequest outbox row to
DONE.

This is the regression guard for #314. The bug report claimed successor dates
were not propagating after a dependency edit. Static analysis showed the CPM
forward pass and the ScheduleRequest DONE transition are correct; this test
locks both behaviours in so any future regression in the backend cascade is
caught at test time rather than as a stale Schedule view in production.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus
from trueppm_api.apps.scheduling.services import enqueue_recalculate
from trueppm_api.apps.scheduling.tasks import _run_schedule

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="StdCascade")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="CascadeProj",
        start_date=date(2026, 1, 5),  # Monday
        calendar=calendar,
    )


@pytest.fixture
def chain(project: Project) -> tuple[Task, Task, Task, Task]:
    """A → B → C → D, all FS, each duration=2."""
    a = Task.objects.create(project=project, name="A", duration=2)
    b = Task.objects.create(project=project, name="B", duration=2)
    c = Task.objects.create(project=project, name="C", duration=2)
    d = Task.objects.create(project=project, name="D", duration=2)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")
    Dependency.objects.create(predecessor=b, successor=c, dep_type="FS")
    Dependency.objects.create(predecessor=c, successor=d, dep_type="FS")
    return a, b, c, d


def _refresh_chain(chain: tuple[Task, Task, Task, Task]) -> tuple[Task, Task, Task, Task]:
    a, b, c, d = chain
    return (
        Task.objects.get(pk=a.pk),
        Task.objects.get(pk=b.pk),
        Task.objects.get(pk=c.pk),
        Task.objects.get(pk=d.pk),
    )


# ---------------------------------------------------------------------------
# Cascade tests — _run_schedule is invoked directly, broadcast is mocked.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_chain_propagates_through_b_c_d_when_head_duration_grows(
    project: Project, chain: tuple[Task, Task, Task, Task]
) -> None:
    """A 4-task FS chain: lengthening A must push B, C, and D's early_start out."""
    a, _, _, _ = chain
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))

    _, b_before, c_before, d_before = _refresh_chain(chain)
    assert b_before.early_start is not None
    assert c_before.early_start is not None
    assert d_before.early_start is not None

    # Extend A's duration so every successor must shift.
    Task.objects.filter(pk=a.pk).update(duration=5)

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk), changed_task_ids=[str(a.pk)])

    _, b_after, c_after, d_after = _refresh_chain(chain)

    assert b_after.early_start > b_before.early_start, (
        f"B did not cascade: before={b_before.early_start} after={b_after.early_start}"
    )
    assert c_after.early_start > c_before.early_start, (
        f"C did not cascade: before={c_before.early_start} after={c_after.early_start}"
    )
    assert d_after.early_start > d_before.early_start, (
        f"D did not cascade: before={d_before.early_start} after={d_after.early_start}"
    )


@pytest.mark.django_db
def test_chain_propagates_when_head_dependency_lag_grows(
    project: Project, chain: tuple[Task, Task, Task, Task]
) -> None:
    """Increasing the lag on the A→B FS edge must shift B, C, and D."""
    a, b, _, _ = chain
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))

    _, b_before, c_before, d_before = _refresh_chain(chain)

    # Edit the head edge — add 5 days of lag to A→B.
    Dependency.objects.filter(predecessor=a, successor=b, dep_type="FS").update(lag=5)

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk), changed_task_ids=[str(b.pk)])

    _, b_after, c_after, d_after = _refresh_chain(chain)

    assert b_after.early_start > b_before.early_start, (
        f"B did not absorb head-edge lag: before={b_before.early_start} after={b_after.early_start}"
    )
    assert c_after.early_start > c_before.early_start, (
        f"C did not cascade from head-edge lag change: before={c_before.early_start} "
        f"after={c_after.early_start}"
    )
    assert d_after.early_start > d_before.early_start, (
        f"D did not cascade from head-edge lag change: before={d_before.early_start} "
        f"after={d_after.early_start}"
    )


# ---------------------------------------------------------------------------
# Outbox transition — _run_schedule must drive ScheduleRequest to DONE.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_run_schedule_marks_outbox_row_done(
    project: Project, chain: tuple[Task, Task, Task, Task]
) -> None:
    """ScheduleRequest must reach DONE — not stick at PENDING/DISPATCHED.

    A row stuck at DISPATCHED means the cpm_complete signal never fires for
    the originating client (it relies on the drain task to retry, but no fresh
    broadcast is sent), which is the failure mode the issue body described.
    """
    req = ScheduleRequest.objects.create(project=project)
    ScheduleRequest.objects.filter(pk=req.pk).update(status=ScheduleRequestStatus.DISPATCHED)

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))

    req.refresh_from_db()
    assert req.status == ScheduleRequestStatus.DONE, (
        f"Outbox row stuck at {req.status} — frontend will never get the "
        "cpm_complete signal and must rely solely on the 2 s poll."
    )


@pytest.mark.django_db(transaction=True)
def test_enqueue_recalculate_writes_outbox_row(
    project: Project, chain: tuple[Task, Task, Task, Task]
) -> None:
    """enqueue_recalculate must always write a ScheduleRequest row.

    The DONE transition itself is exercised by ``test_run_schedule_marks_outbox_row_done``;
    here we cover the outbox-write contract that ``DependencyViewSet`` and the
    ``msproject`` import path rely on, even when the broker is unreachable
    (the row is left PENDING for the drain task to pick up).
    """
    enqueue_recalculate(str(project.pk))

    rows = ScheduleRequest.objects.filter(project=project).order_by("-requested_at")
    assert rows.exists(), "enqueue_recalculate did not create an outbox row"


# ---------------------------------------------------------------------------
# Per-task WebSocket date deltas (ADR-0091).
# ---------------------------------------------------------------------------


def _delta_call(mock_broadcast: object) -> dict[str, object]:
    """Return the payload of the single task_dates_updated broadcast call."""
    deltas = [
        c.kwargs["payload"]
        for c in mock_broadcast.call_args_list  # type: ignore[attr-defined]
        if c.kwargs.get("event_type") == "task_dates_updated"
    ]
    assert len(deltas) == 1, f"expected exactly one task_dates_updated broadcast, got {len(deltas)}"
    return deltas[0]


@pytest.mark.django_db
def test_run_schedule_broadcasts_per_task_date_deltas(
    project: Project,
    chain: tuple[Task, Task, Task, Task],
    django_capture_on_commit_callbacks: object,
) -> None:
    """_run_schedule must emit a batched task_dates_updated event carrying the
    moved tasks' CPM fields, so collaborators' bars slide without a re-fetch.

    The broadcast is deferred to transaction.on_commit (#896), so the test
    captures and executes the on-commit callbacks to observe it.
    """
    a, b, c, d = chain
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        _run_schedule(str(project.pk))

    payload = _delta_call(mock_broadcast)

    assert payload["count"] == 4
    assert "truncated" not in payload
    by_id = {t["id"]: t for t in payload["tasks"]}  # type: ignore[union-attr]
    assert by_id.keys() == {str(a.pk), str(b.pk), str(c.pk), str(d.pk)}

    # Field-name + value contract (must mirror SyncTaskSerializer per ADR-0082).
    head = by_id[str(a.pk)]
    for field in (
        "early_start",
        "early_finish",
        "late_start",
        "late_finish",
        "total_float",
        "free_float",
        "is_critical",
        "planned_start",
        "duration",
    ):
        assert field in head, f"delta missing {field}"
    # Dates are ISO strings (JSON-serializable), not date objects.
    assert isinstance(head["early_start"], str)
    assert isinstance(head["is_critical"], bool)


@pytest.mark.django_db
def test_run_schedule_truncates_delta_above_cap(
    project: Project,
    chain: tuple[Task, Task, Task, Task],
    django_capture_on_commit_callbacks: object,
) -> None:
    """Above CPM_DELTA_BROADCAST_CAP the event carries a truncated flag and no
    task array, so the WS frame stays bounded and the client re-fetches."""
    with (
        patch("trueppm_api.apps.scheduling.tasks.CPM_DELTA_BROADCAST_CAP", 2),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        _run_schedule(str(project.pk))  # 4 tasks > cap of 2

    payload = _delta_call(mock_broadcast)
    assert payload["truncated"] is True
    assert payload["count"] == 4
    assert "tasks" not in payload


@pytest.mark.django_db
def test_run_schedule_defers_broadcasts_to_commit(
    project: Project,
    chain: tuple[Task, Task, Task, Task],
    django_capture_on_commit_callbacks: object,
) -> None:
    """CPM broadcasts must be deferred to transaction.on_commit, not fire eagerly (#896).

    Regression: cpm_complete / task_dates_updated were broadcast immediately after
    bulk_update — *before* the ScheduleRequest status write — so a later failure
    left clients showing dates that never persisted. We now register them with
    transaction.on_commit. Capturing without executing proves nothing broadcasts
    until the enclosing transaction commits; executing then fires them.
    """
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        # execute=False: callbacks are collected but NOT run. If _run_schedule
        # broadcast eagerly, mock_broadcast would already have been called here.
        with django_capture_on_commit_callbacks(execute=False) as callbacks:  # type: ignore[operator]
            _run_schedule(str(project.pk))
            assert mock_broadcast.call_count == 0, "broadcast fired before commit"

        # Two deferred board broadcasts were registered (cpm_complete + dates).
        assert len(callbacks) >= 2  # type: ignore[arg-type]

        # Now run the captured callbacks (simulating commit) — broadcasts fire.
        for cb in callbacks:  # type: ignore[attr-defined]
            cb()
        event_types = {c.kwargs.get("event_type") for c in mock_broadcast.call_args_list}
        assert "cpm_complete" in event_types
        assert "task_dates_updated" in event_types
