"""Default workflow backend — engine semantics (ADR-0080, #652).

Covers the declarative TaskChain engine end to end: start + idempotent dedup,
chain completion, once-and-only-once activities, saga compensation on failure,
cancel, state/history reads, the outbox drain (re-dispatch + orphan recovery +
orphan window), the sleep-timer drain, and retention purge.

The chain is driven by calling ``_do_advance`` on each PENDING outbox row
directly: under the test transaction ``transaction.on_commit`` callbacks (the
real dispatch path) never fire, so tests advance the chain explicitly — the
documented testable entry point.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.utils import timezone

from trueppm_api.apps.workflow_engine.models import (
    WorkflowActivityExecution,
    WorkflowHistoryEvent,
    WorkflowInstance,
    WorkflowOutboxRow,
    WorkflowOutboxStatus,
    WorkflowStatus,
    WorkflowTimer,
)
from trueppm_api.apps.workflow_engine.tasks import (
    _MAX_STEP_ATTEMPTS,
    _complete,
    _do_advance,
    _do_outbox_drain,
    _do_purge_workflow_records,
    _do_timer_drain,
)
from trueppm_api.workflows.backends.default import DefaultWorkflowBackend, run_activity_oaoo
from trueppm_api.workflows.interface import NonRetryableError
from trueppm_api.workflows.registry import WORKFLOWS, WorkflowDefinition, WorkflowStep

pytestmark = pytest.mark.django_db


@pytest.fixture
def registry() -> Iterator[None]:
    """Isolate the global workflow registry per test (save → clear → restore)."""
    saved = WORKFLOWS.all()
    WORKFLOWS.clear()
    yield
    WORKFLOWS.clear()
    for definition in saved.values():
        WORKFLOWS.register(definition)


@pytest.fixture
def backend() -> DefaultWorkflowBackend:
    return DefaultWorkflowBackend()


def _register(name: str, steps: list[WorkflowStep]) -> WorkflowDefinition:
    """Register a simple chain definition under ``name``."""

    class _Chain(WorkflowDefinition):
        def build_steps(self, workflow_input: dict[str, Any]) -> list[WorkflowStep]:
            return steps

    definition = _Chain()
    definition.name = name
    return WORKFLOWS.register(definition)


def _drive(workflow_id: str) -> None:
    """Run every PENDING step row to completion, mirroring the drain/Celery loop."""
    while True:
        row = WorkflowOutboxRow.objects.filter(
            workflow_id=workflow_id, status=WorkflowOutboxStatus.PENDING
        ).first()
        if row is None:
            return
        _do_advance(str(row.id))


# ---------------------------------------------------------------------------
# Start + idempotency
# ---------------------------------------------------------------------------


def test_start_creates_instance_and_first_step_row(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    _register("noop", [WorkflowStep("a", lambda ctx: {"ok": True})])
    wf_id = backend.start_workflow("noop", {"x": 1})

    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.RUNNING
    assert instance.input == {"x": 1}
    assert instance.idempotency_key  # deterministic default key was set
    assert WorkflowHistoryEvent.objects.filter(
        workflow=instance, event_type="workflow_started"
    ).exists()
    row = WorkflowOutboxRow.objects.get(workflow=instance)
    assert row.status == WorkflowOutboxStatus.PENDING
    assert row.step_input == {"step_index": 0}


def test_start_is_idempotent(registry: None, backend: DefaultWorkflowBackend) -> None:
    _register("noop", [WorkflowStep("a", lambda ctx: None)])
    first = backend.start_workflow("noop", {"x": 1})
    second = backend.start_workflow("noop", {"x": 1})
    assert first == second
    assert WorkflowInstance.objects.count() == 1


def test_start_unregistered_workflow_raises(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    with pytest.raises(KeyError):
        backend.start_workflow("does-not-exist", {})
    assert WorkflowInstance.objects.count() == 0


def test_wait_for_completion_not_supported(registry: None, backend: DefaultWorkflowBackend) -> None:
    _register("noop", [WorkflowStep("a", lambda ctx: None)])
    with pytest.raises(NotImplementedError):
        backend.start_workflow("noop", {}, wait_for_completion=True)


# ---------------------------------------------------------------------------
# Chain execution
# ---------------------------------------------------------------------------


def test_chain_runs_to_completion(registry: None, backend: DefaultWorkflowBackend) -> None:
    calls: list[str] = []
    _register(
        "two_step",
        [
            WorkflowStep("first", lambda ctx: (calls.append("first"), {"r": 1})[1]),
            WorkflowStep("second", lambda ctx: (calls.append("second"), {"r": 2})[1]),
        ],
    )
    wf_id = backend.start_workflow("two_step", {})
    _drive(wf_id)

    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.COMPLETED
    assert instance.completed_at is not None
    assert calls == ["first", "second"]
    # Result aggregates each activity's recorded output.
    assert instance.result == {"first": {"r": 1}, "second": {"r": 2}}
    types = list(
        WorkflowHistoryEvent.objects.filter(workflow=instance)
        .order_by("seq")
        .values_list("event_type", flat=True)
    )
    assert types == [
        "workflow_started",
        "step_completed",
        "step_completed",
        "workflow_completed",
    ]


def test_later_step_sees_prior_results(registry: None, backend: DefaultWorkflowBackend) -> None:
    seen: dict[str, Any] = {}
    _register(
        "passes_context",
        [
            WorkflowStep("produce", lambda ctx: {"value": 42}),
            WorkflowStep("consume", lambda ctx: seen.update(ctx["prior"]) or None),
        ],
    )
    wf_id = backend.start_workflow("passes_context", {"seed": "s"})
    _drive(wf_id)
    assert seen == {"produce": {"value": 42}}


def test_step_redelivery_runs_activity_once(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    count = {"n": 0}

    def once(ctx: dict[str, Any]) -> dict[str, Any]:
        count["n"] += 1
        return {"n": count["n"]}

    _register("single", [WorkflowStep("a", once)])
    wf_id = backend.start_workflow("single", {})
    row = WorkflowOutboxRow.objects.get(workflow_id=wf_id)
    _do_advance(str(row.id))
    _do_advance(str(row.id))  # redelivery — row already DONE, must be a no-op
    assert count["n"] == 1


def test_run_activity_oaoo_returns_cached_result(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    _register("x", [WorkflowStep("a", lambda ctx: None)])
    instance = WorkflowInstance.objects.create(
        name="x", input={}, idempotency_key="k", status=WorkflowStatus.RUNNING
    )
    count = {"n": 0}

    def activity(ctx: dict[str, Any]) -> dict[str, Any]:
        count["n"] += 1
        return {"n": count["n"]}

    first = run_activity_oaoo(instance, "a", {"in": 1}, activity)
    second = run_activity_oaoo(instance, "a", {"in": 1}, activity)
    assert first == second == {"n": 1}
    assert count["n"] == 1
    assert (
        WorkflowActivityExecution.objects.filter(workflow=instance, activity_name="a").count() == 1
    )


def test_completion_result_excludes_none_final_step(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    """A final step returning None is excluded from the aggregate result, the
    same as the prior WorkflowActivityExecution query (which did .exclude(result=None))."""
    _register(
        "ends_none",
        [
            WorkflowStep("produce", lambda ctx: {"value": 1}),
            WorkflowStep("noop_tail", lambda ctx: None),
        ],
    )
    wf_id = backend.start_workflow("ends_none", {})
    _drive(wf_id)
    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.COMPLETED
    assert instance.result == {"produce": {"value": 1}}  # None tail omitted


def test_complete_uses_passed_results_without_requerying(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    """_complete finalizes from the caller-supplied aggregate, not a fresh scan
    of WorkflowActivityExecution. Passing a result with no matching execution row
    proves the value comes from the argument, not the DB (the collapsed query)."""
    instance = WorkflowInstance.objects.create(
        name="x", input={}, idempotency_key="k", status=WorkflowStatus.RUNNING
    )
    _complete(instance, {"phantom": {"v": 9}})
    instance.refresh_from_db()
    assert instance.status == WorkflowStatus.COMPLETED
    assert instance.completed_at is not None
    # No WorkflowActivityExecution rows exist; a re-query would have yielded {}.
    assert instance.result == {"phantom": {"v": 9}}
    assert WorkflowHistoryEvent.objects.filter(
        workflow=instance, event_type="workflow_completed"
    ).exists()


# ---------------------------------------------------------------------------
# Failure + compensation
# ---------------------------------------------------------------------------


def test_failure_compensates_completed_steps_in_reverse(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    events: list[str] = []

    def boom(ctx: dict[str, Any]) -> dict[str, Any]:
        raise NonRetryableError("step three failed")

    _register(
        "saga",
        [
            WorkflowStep(
                "one",
                lambda ctx: {"ok": 1},
                compensate=lambda ctx: events.append("undo_one"),
            ),
            WorkflowStep(
                "two",
                lambda ctx: {"ok": 2},
                compensate=lambda ctx: events.append("undo_two"),
            ),
            WorkflowStep("three", boom),
        ],
    )
    wf_id = backend.start_workflow("saga", {})
    _drive(wf_id)

    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.FAILED
    assert "step three failed" in instance.error
    # Reverse order: two before one.
    assert events == ["undo_two", "undo_one"]
    assert WorkflowHistoryEvent.objects.filter(
        workflow=instance, event_type="workflow_failed"
    ).exists()


def test_compensation_failure_does_not_mask_original(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    def bad_compensate(ctx: dict[str, Any]) -> None:
        raise RuntimeError("rollback blew up")

    _register(
        "saga2",
        [
            WorkflowStep("one", lambda ctx: {"ok": 1}, compensate=bad_compensate),
            WorkflowStep("two", lambda ctx: (_ for _ in ()).throw(NonRetryableError("two failed"))),
        ],
    )
    wf_id = backend.start_workflow("saga2", {})
    _drive(wf_id)
    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.FAILED
    assert "two failed" in instance.error  # original failure preserved


# ---------------------------------------------------------------------------
# Cancel + reads
# ---------------------------------------------------------------------------


def test_cancel_running_workflow(registry: None, backend: DefaultWorkflowBackend) -> None:
    _register("c", [WorkflowStep("a", lambda ctx: None)])
    wf_id = backend.start_workflow("c", {})
    backend.cancel_workflow(wf_id, reason="user aborted")
    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.CANCELED
    assert instance.cancel_reason == "user aborted"


def test_cancel_terminal_workflow_is_noop(registry: None, backend: DefaultWorkflowBackend) -> None:
    _register("c", [WorkflowStep("a", lambda ctx: {"done": True})])
    wf_id = backend.start_workflow("c", {})
    _drive(wf_id)  # COMPLETED
    backend.cancel_workflow(wf_id, reason="too late")
    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.COMPLETED  # unchanged


def test_get_state_and_history(registry: None, backend: DefaultWorkflowBackend) -> None:
    _register("h", [WorkflowStep("a", lambda ctx: {"v": 1})])
    wf_id = backend.start_workflow("h", {"in": 9})
    _drive(wf_id)

    state = backend.get_workflow_state(wf_id)
    assert state.workflow_id == wf_id
    assert state.status == WorkflowStatus.COMPLETED
    assert state.result == {"a": {"v": 1}}

    history = backend.get_history(wf_id)
    assert [e.seq for e in history] == sorted(e.seq for e in history)  # ordered by seq
    assert history[0].event_type == "workflow_started"


# ---------------------------------------------------------------------------
# Outbox drain
# ---------------------------------------------------------------------------


def _backdate_outbox(row_id: str, minutes: int) -> None:
    when = timezone.now() - timedelta(minutes=minutes)
    WorkflowOutboxRow.objects.filter(id=row_id).update(created_at=when, dispatched_at=when)


def test_drain_redispatches_old_pending(registry: None, backend: DefaultWorkflowBackend) -> None:
    _register("d", [WorkflowStep("a", lambda ctx: None)])
    wf_id = backend.start_workflow("d", {})
    row = WorkflowOutboxRow.objects.get(workflow_id=wf_id)
    _backdate_outbox(str(row.id), minutes=6)  # past the 5-min orphan window

    with patch("trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay") as delay:
        delay.return_value = MagicMock(id="task-123")
        _do_outbox_drain()

    delay.assert_called_once_with(str(row.id))
    row.refresh_from_db()
    assert row.status == WorkflowOutboxStatus.DISPATCHED


def test_drain_propagates_soft_time_limit_and_leaves_row_pending(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    from celery.exceptions import SoftTimeLimitExceeded

    _register("d", [WorkflowStep("a", lambda ctx: None)])
    wf_id = backend.start_workflow("d", {})
    row = WorkflowOutboxRow.objects.get(workflow_id=wf_id)
    _backdate_outbox(str(row.id), minutes=6)

    with (
        patch(
            "trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay",
            side_effect=SoftTimeLimitExceeded(),
        ),
        pytest.raises(SoftTimeLimitExceeded),
    ):
        _do_outbox_drain()

    row.refresh_from_db()
    assert row.status == WorkflowOutboxStatus.PENDING


def test_drain_skips_recent_pending(registry: None, backend: DefaultWorkflowBackend) -> None:
    _register("d", [WorkflowStep("a", lambda ctx: None)])
    backend.start_workflow("d", {})  # row created just now (inside orphan window)
    with patch("trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay") as delay:
        _do_outbox_drain()
    delay.assert_not_called()


def test_drain_recovers_orphaned_dispatched(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    _register("d", [WorkflowStep("a", lambda ctx: None)])
    wf_id = backend.start_workflow("d", {})
    row = WorkflowOutboxRow.objects.get(workflow_id=wf_id)
    row.status = WorkflowOutboxStatus.DISPATCHED
    row.save(update_fields=["status"])
    _backdate_outbox(str(row.id), minutes=11)  # past the 10-min recovery window

    with patch("trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay") as delay:
        delay.return_value = MagicMock(id="task-456")
        _do_outbox_drain()

    row.refresh_from_db()
    # Recovered to PENDING then re-dispatched in the same drain pass.
    assert row.status == WorkflowOutboxStatus.DISPATCHED
    delay.assert_called_once()


# ---------------------------------------------------------------------------
# Timer drain + purge
# ---------------------------------------------------------------------------


def test_timer_drain_fires_due_timer_and_wakes(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    _register("s", [WorkflowStep("a", lambda ctx: None)])
    wf_id = backend.start_workflow("s", {})
    backend.sleep(wf_id, timedelta(minutes=10))
    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.SLEEPING
    timer = WorkflowTimer.objects.get(workflow=instance)
    WorkflowTimer.objects.filter(id=timer.id).update(fire_at=timezone.now() - timedelta(minutes=1))

    _do_timer_drain()

    timer.refresh_from_db()
    instance.refresh_from_db()
    assert timer.fired is True
    assert instance.status == WorkflowStatus.RUNNING


def test_purge_deletes_old_terminal_rows_and_history(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    _register("p", [WorkflowStep("a", lambda ctx: {"v": 1})])
    wf_id = backend.start_workflow("p", {})
    _drive(wf_id)  # creates a DONE outbox row + history

    # Past both windows: 7-day outbox retention and 30-day history retention.
    old = timezone.now() - timedelta(days=31)
    WorkflowOutboxRow.objects.filter(workflow_id=wf_id).update(created_at=old)
    WorkflowHistoryEvent.objects.filter(workflow_id=wf_id).update(created_at=old)

    _do_purge_workflow_records()

    assert WorkflowOutboxRow.objects.filter(workflow_id=wf_id).count() == 0
    assert WorkflowHistoryEvent.objects.filter(workflow_id=wf_id).count() == 0


def test_purge_chunks_across_batch_boundary(
    registry: None, backend: DefaultWorkflowBackend, settings: Any
) -> None:
    """With more eligible rows than the batch size, the purge must loop until the
    set is drained — a single bounded delete would leave the remainder behind."""
    settings.WORKFLOW_PURGE_BATCH_SIZE = 2
    instance = WorkflowInstance.objects.create(
        name="bulk", input={}, idempotency_key="bulk-k", status=WorkflowStatus.COMPLETED
    )
    old = timezone.now() - timedelta(days=31)
    for seq in range(5):
        WorkflowHistoryEvent.objects.create(workflow=instance, seq=seq, event_type="e", payload={})
        WorkflowOutboxRow.objects.create(
            workflow=instance,
            step_name=str(seq),
            step_input={},
            status=WorkflowOutboxStatus.DONE,
        )
    WorkflowHistoryEvent.objects.filter(workflow=instance).update(created_at=old)
    WorkflowOutboxRow.objects.filter(workflow=instance).update(created_at=old)
    assert WorkflowHistoryEvent.objects.filter(workflow=instance).count() == 5  # > batch size

    _do_purge_workflow_records()

    # Every eligible row deleted despite five rows / batch of two (loop ran 3x).
    assert WorkflowHistoryEvent.objects.filter(workflow=instance).count() == 0
    assert WorkflowOutboxRow.objects.filter(workflow=instance).count() == 0


# ---------------------------------------------------------------------------
# Index coverage
# ---------------------------------------------------------------------------


def test_outbox_recovery_index_covers_drain_recovery_filter() -> None:
    """The drain recovers orphaned DISPATCHED rows by ranging on dispatched_at.

    Asserting on model Meta (not by importing the migration module) keeps the
    test decoupled from migration file names, which a squash can rename.
    """
    index = {idx.name: idx for idx in WorkflowOutboxRow._meta.indexes}
    assert "workflow_outbox_recovery_idx" in index
    assert index["workflow_outbox_recovery_idx"].fields == ["status", "dispatched_at"]


# ---------------------------------------------------------------------------
# Failure recovery (#2994) — the #2894 class: terminal, unobservable, unrecoverable
# ---------------------------------------------------------------------------


def _flaky(fail_times: int) -> Any:
    """An activity that raises ``fail_times`` times, then succeeds."""
    calls = {"n": 0}

    def activity(ctx: dict[str, Any]) -> dict[str, Any]:
        calls["n"] += 1
        if calls["n"] <= fail_times:
            raise RuntimeError(f"transient {calls['n']}")
        return {"ok": True}

    return activity


def _expire_retry_clock(row_id: str) -> None:
    WorkflowOutboxRow.objects.filter(id=row_id).update(
        next_attempt_at=timezone.now() - timedelta(seconds=1)
    )


def test_transient_failure_schedules_retry_and_does_not_fail_workflow(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    events: list[str] = []
    _register(
        "flaky",
        [
            WorkflowStep("one", lambda ctx: {"a": 1}, compensate=lambda ctx: events.append("undo")),
            WorkflowStep("two", _flaky(1)),
        ],
    )
    wf_id = backend.start_workflow("flaky", {})
    _drive(wf_id)

    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.RUNNING  # not FAILED, not rolled back
    assert events == []
    row = WorkflowOutboxRow.objects.filter(workflow=instance).order_by("-created_at").first()
    assert row is not None
    assert row.status == WorkflowOutboxStatus.DEAD
    assert row.next_attempt_at is not None  # live clock: not terminal
    assert row.failure_reason == "error"
    assert "transient 1" in row.error_message
    assert row.attempt_count == 1


def test_drain_requeues_failed_row_and_workflow_completes(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    _register("flaky2", [WorkflowStep("only", _flaky(1))])
    wf_id = backend.start_workflow("flaky2", {})
    _drive(wf_id)
    row = WorkflowOutboxRow.objects.get(workflow_id=wf_id)

    # Clock not yet due: the drain leaves it alone.
    with patch("trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay") as delay:
        delay.return_value = MagicMock(id="t1")
        _do_outbox_drain()
    delay.assert_not_called()

    _expire_retry_clock(str(row.id))
    with patch("trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay") as delay:
        delay.return_value = MagicMock(id="t2")
        _do_outbox_drain()
    delay.assert_called_once_with(str(row.id))
    row.refresh_from_db()
    assert row.status == WorkflowOutboxStatus.DISPATCHED
    assert row.next_attempt_at is None

    _do_advance(str(row.id))  # the dispatched retry runs
    assert WorkflowInstance.objects.get(id=wf_id).status == WorkflowStatus.COMPLETED
    row.refresh_from_db()
    assert row.status == WorkflowOutboxStatus.DONE
    assert row.attempt_count == 2
    assert row.error_message == ""


def test_budget_exhaustion_is_terminal_and_compensates(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    events: list[str] = []
    _register(
        "always",
        [
            WorkflowStep("one", lambda ctx: {"a": 1}, compensate=lambda ctx: events.append("undo")),
            WorkflowStep("two", _flaky(10_000)),
        ],
    )
    wf_id = backend.start_workflow("always", {})
    _drive(wf_id)
    row = WorkflowOutboxRow.objects.filter(workflow_id=wf_id).order_by("-created_at").first()
    assert row is not None
    for _ in range(_MAX_STEP_ATTEMPTS - 1):
        _expire_retry_clock(str(row.id))
        with patch("trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay") as d:
            d.return_value = MagicMock(id="x")
            _do_outbox_drain()
        _do_advance(str(row.id))
        row.refresh_from_db()

    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.FAILED
    assert events == ["undo"]
    assert row.attempt_count == _MAX_STEP_ATTEMPTS
    assert row.status == WorkflowOutboxStatus.DEAD
    assert row.next_attempt_at is None  # null == no further attempt

    # Terminal means the drain never touches it again.
    with patch("trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay") as d:
        _do_outbox_drain()
    d.assert_not_called()


def test_non_retryable_failure_is_terminal_on_first_attempt(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    def boom(ctx: dict[str, Any]) -> None:
        raise NonRetryableError("cannot work")

    _register("unfixable", [WorkflowStep("a", boom)])
    wf_id = backend.start_workflow("unfixable", {})
    _drive(wf_id)
    row = WorkflowOutboxRow.objects.get(workflow_id=wf_id)
    assert WorkflowInstance.objects.get(id=wf_id).status == WorkflowStatus.FAILED
    assert row.next_attempt_at is None
    assert row.failure_reason == "unfixable"


def test_orphan_recovery_is_bounded_and_abandons_into_failed(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    _register("orph", [WorkflowStep("a", lambda ctx: None)])
    wf_id = backend.start_workflow("orph", {})
    row = WorkflowOutboxRow.objects.get(workflow_id=wf_id)
    WorkflowOutboxRow.objects.filter(id=row.id).update(
        status=WorkflowOutboxStatus.DISPATCHED,
        attempt_count=_MAX_STEP_ATTEMPTS,
        dispatched_at=timezone.now() - timedelta(minutes=11),
    )
    with patch("trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay") as d:
        _do_outbox_drain()
    d.assert_not_called()
    row.refresh_from_db()
    assert row.status == WorkflowOutboxStatus.DEAD  # abandoned, not wedged DISPATCHED
    assert row.failure_reason == "stalled"
    assert row.next_attempt_at is None
    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.FAILED
    assert "stopped responding" in instance.error


def test_purge_spares_dead_row_with_live_retry_clock(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    _register("pg", [WorkflowStep("a", lambda ctx: None)])
    live = backend.start_workflow("pg", {"k": 1})
    terminal = backend.start_workflow("pg", {"k": 2})
    old = timezone.now() - timedelta(days=30)
    WorkflowOutboxRow.objects.filter(workflow_id=live).update(
        status=WorkflowOutboxStatus.DEAD,
        created_at=old,
        next_attempt_at=timezone.now() + timedelta(seconds=60),
    )
    WorkflowOutboxRow.objects.filter(workflow_id=terminal).update(
        status=WorkflowOutboxStatus.DEAD, created_at=old
    )
    _do_purge_workflow_records()
    assert WorkflowOutboxRow.objects.filter(workflow_id=live).exists()
    assert not WorkflowOutboxRow.objects.filter(workflow_id=terminal).exists()


def test_restart_failed_reruns_a_failed_workflow(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    def boom(ctx: dict[str, Any]) -> None:
        raise NonRetryableError("x")

    _register("rs", [WorkflowStep("a", boom)])
    wf_id = backend.start_workflow("rs", {}, idempotency_key="k")
    _drive(wf_id)
    assert WorkflowInstance.objects.get(id=wf_id).status == WorkflowStatus.FAILED

    # Without the flag the key still returns the failed instance untouched.
    assert backend.start_workflow("rs", {}, idempotency_key="k") == wf_id
    assert WorkflowInstance.objects.get(id=wf_id).status == WorkflowStatus.FAILED

    assert backend.start_workflow("rs", {}, idempotency_key="k", restart_failed=True) == wf_id
    instance = WorkflowInstance.objects.get(id=wf_id)
    assert instance.status == WorkflowStatus.RUNNING
    assert instance.error == ""
    assert WorkflowOutboxRow.objects.filter(
        workflow_id=wf_id, status=WorkflowOutboxStatus.PENDING
    ).exists()


def test_health_card_does_not_count_retrying_row_as_dead(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    from trueppm_api.apps.observability.selectors import _outbox_card

    _register("hc", [WorkflowStep("a", _flaky(1))])
    wf_id = backend.start_workflow("hc", {})
    _drive(wf_id)
    row = WorkflowOutboxRow.objects.get(workflow_id=wf_id)
    assert row.status == WorkflowOutboxStatus.DEAD and row.next_attempt_at is not None
    assert _outbox_card()["status"] != "crit"
    assert "0 dead" in _outbox_card()["meta"]


def test_redelivery_of_retrying_row_keeps_retry_clock(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    """A second delivery of a DEAD row with a live clock must not strand it.

    acks_late / reject_on_worker_lost / orphan re-dispatch can deliver the same
    row again after it failed transiently. That delivery used to clear the clock
    before the locked re-check, which then read the row as terminal and left the
    workflow RUNNING forever.
    """
    _register("redeliver", [WorkflowStep("only", _flaky(1))])
    wf_id = backend.start_workflow("redeliver", {})
    _drive(wf_id)
    row = WorkflowOutboxRow.objects.get(workflow_id=wf_id)
    assert row.status == WorkflowOutboxStatus.DEAD and row.next_attempt_at is not None

    _do_advance(str(row.id))  # the stray second delivery
    row.refresh_from_db()
    assert row.status == WorkflowOutboxStatus.DEAD
    assert row.next_attempt_at is not None
    assert row.attempt_count == 1  # a no-op delivery spends no budget

    _expire_retry_clock(str(row.id))
    with patch("trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay") as d:
        d.return_value = MagicMock(id="t")
        _do_outbox_drain()
    d.assert_called_once_with(str(row.id))
    _do_advance(str(row.id))
    assert WorkflowInstance.objects.get(id=wf_id).status == WorkflowStatus.COMPLETED


def test_failed_attempt_partial_writes_roll_back(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    """An activity that writes and then raises leaves nothing behind for the retry."""
    marker = "partial-write-2994"

    def writes_then_raises(ctx: dict[str, Any]) -> None:
        WorkflowInstance.objects.create(
            name="side", input={}, idempotency_key=marker, status=WorkflowStatus.RUNNING
        )
        raise RuntimeError("after the write")

    _register("partial", [WorkflowStep("a", writes_then_raises)])
    wf_id = backend.start_workflow("partial", {})
    _drive(wf_id)
    assert not WorkflowInstance.objects.filter(idempotency_key=marker).exists()
    # The engine's own bookkeeping outside the savepoint survived.
    assert WorkflowHistoryEvent.objects.filter(
        workflow_id=wf_id, event_type="step_retry_scheduled"
    ).exists()


def test_service_does_not_pass_restart_failed_to_a_legacy_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A backend written against the pre-#2994 signature keeps working."""
    from trueppm_api.workflows import services

    calls: list[dict[str, Any]] = []

    class _Legacy:
        def start_workflow(
            self,
            name: str,
            input: dict[str, Any],
            *,
            idempotency_key: str | None = None,
            wait_for_completion: bool = False,
        ) -> str:
            calls.append({"name": name, "key": idempotency_key})
            return "legacy-id"

    monkeypatch.setattr(services, "get_backend", lambda: _Legacy())
    assert services.start_workflow("x", {}, idempotency_key="k") == "legacy-id"
    assert calls == [{"name": "x", "key": "k"}]
    # Opting in against a backend that cannot honor it fails loudly, not silently.
    with pytest.raises(TypeError):
        services.start_workflow("x", {}, restart_failed=True)


def test_restart_failed_is_refused_after_compensation(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    from trueppm_api.workflows import RestartRefusedError

    def boom(ctx: dict[str, Any]) -> None:
        raise NonRetryableError("x")

    _register(
        "comp",
        [
            WorkflowStep("one", lambda ctx: {"a": 1}, compensate=lambda ctx: None),
            WorkflowStep("two", boom),
        ],
    )
    wf_id = backend.start_workflow("comp", {}, idempotency_key="ck")
    _drive(wf_id)
    assert WorkflowInstance.objects.get(id=wf_id).status == WorkflowStatus.FAILED
    with pytest.raises(RestartRefusedError):
        backend.start_workflow("comp", {}, idempotency_key="ck", restart_failed=True)
    assert WorkflowInstance.objects.get(id=wf_id).status == WorkflowStatus.FAILED


def test_retry_sweep_flips_only_the_rows_it_dispatches(
    registry: None, backend: DefaultWorkflowBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.workflow_engine import tasks

    monkeypatch.setattr(tasks, "_RETRY_DISPATCH_BUDGET", 2)
    # One shared activity that always fails transiently (a fresh _flaky per row
    # would be needed otherwise: its counter is shared across instances).
    _register("many", [WorkflowStep("a", _flaky(10_000))])
    ids = []
    for i in range(5):
        wf_id = backend.start_workflow("many", {"i": i})
        _drive(wf_id)
        row = WorkflowOutboxRow.objects.get(workflow_id=wf_id)
        _expire_retry_clock(str(row.id))
        ids.append(row.id)

    with patch("trueppm_api.apps.workflow_engine.tasks.advance_workflow_step.delay") as d:
        d.return_value = MagicMock(id="t")
        _do_outbox_drain()
    assert d.call_count == 2
    rows = WorkflowOutboxRow.objects.filter(id__in=ids)
    assert rows.filter(status=WorkflowOutboxStatus.DISPATCHED).count() == 2
    assert rows.filter(status=WorkflowOutboxStatus.PENDING).count() == 0
    # The other three are still DEAD with their clock, waiting for the next sweep.
    assert rows.filter(status=WorkflowOutboxStatus.DEAD, next_attempt_at__isnull=False).count() == 3
