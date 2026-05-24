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
    _do_advance,
    _do_outbox_drain,
    _do_purge_workflow_records,
    _do_timer_drain,
)
from trueppm_api.workflows.backends.default import DefaultWorkflowBackend, run_activity_oaoo
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


# ---------------------------------------------------------------------------
# Failure + compensation
# ---------------------------------------------------------------------------


def test_failure_compensates_completed_steps_in_reverse(
    registry: None, backend: DefaultWorkflowBackend
) -> None:
    events: list[str] = []

    def boom(ctx: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("step three failed")

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
            WorkflowStep("two", lambda ctx: (_ for _ in ()).throw(RuntimeError("two failed"))),
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
