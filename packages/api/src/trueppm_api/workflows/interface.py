"""Backend-neutral workflow execution interface (ADR-0080 §A).

This module is the contract every workflow backend implements — the default
outbox-composing backend today, a DBOS backend in 1.0. It is deliberately pure
Python: it imports no engine module (``celery``, ``dbos``, ``temporalio``) and no
Django, so it can serve as the stable, neutral surface that both workflow
consumer code and backend implementations depend on.

The eight primitives are intentionally narrow. Child workflows, continue-as-new,
and deterministic-replay guarantees are excluded because they leak engine-specific
(Temporal) semantics into workflow code and would break the abstraction.
"""

from __future__ import annotations

import enum
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any


class WorkflowStatus(enum.StrEnum):
    """Backend-neutral workflow lifecycle status.

    Values mirror ``trueppm_api.apps.workflow_engine.models.WorkflowStatus`` (the
    default backend's persistence enum) and must stay in sync; they are defined
    here too so consumers can reason about status without importing Django models.
    """

    PENDING = "pending"
    RUNNING = "running"
    SLEEPING = "sleeping"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELED = "canceled"


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Retry behaviour for an activity run via :meth:`WorkflowBackend.run_activity`.

    Backend-neutral: each backend translates these fields into its own retry
    mechanism (the default backend maps them onto Celery's retry kwargs).
    """

    max_attempts: int = 3
    initial_backoff: timedelta = timedelta(seconds=1)
    backoff_multiplier: float = 2.0
    max_backoff: timedelta = timedelta(minutes=5)


@dataclass(frozen=True, slots=True)
class HistoryEvent:
    """One entry in a workflow's ordered, append-only history."""

    seq: int
    event_type: str
    payload: dict[str, Any]
    occurred_at: datetime


@dataclass(frozen=True, slots=True)
class WorkflowState:
    """A point-in-time read model of a workflow instance.

    Returned by :meth:`WorkflowBackend.get_workflow_state`. Intentionally a plain
    value object, not a Django model, so consumers never bind to the default
    backend's persistence layer.
    """

    workflow_id: str
    name: str
    status: WorkflowStatus
    result: dict[str, Any] | None = None
    error: str = ""
    created_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None


class WorkflowBackend(ABC):
    """The eight-primitive workflow execution contract (ADR-0080 §A).

    Implemented by each backend (default outbox-composing; future DBOS). Workflow
    consumer code never calls a backend directly — it goes through
    :mod:`trueppm_api.workflows.services`, which resolves the configured backend.
    There is deliberately no ``_backend`` parameter on any method: if workflow
    code ever needed to know which backend it runs on, the abstraction would have
    already failed (ADR-0080 §E).
    """

    @abstractmethod
    def start_workflow(
        self,
        name: str,
        input: dict[str, Any],
        *,
        idempotency_key: str | None = None,
        wait_for_completion: bool = False,
    ) -> str:
        """Start a workflow and return its id.

        Fire-and-forget by default (``wait_for_completion=False``); blocking on
        completion defeats the durability guarantee and is reserved for
        bounded-short workflows. ``idempotency_key`` defaults to a deterministic
        hash of ``name`` + ``input`` so a retried start does not duplicate work.
        """

    @abstractmethod
    def signal_workflow(self, workflow_id: str, signal: str, payload: dict[str, Any]) -> None:
        """Deliver a named signal to a workflow.

        Durable: a signal that arrives before the workflow waits for it is queued,
        not dropped.
        """

    @abstractmethod
    def query_workflow(self, workflow_id: str, query: str, args: dict[str, Any]) -> Any:
        """Run a named read-only query against a workflow's current state."""

    @abstractmethod
    def get_workflow_state(self, workflow_id: str) -> WorkflowState:
        """Return a point-in-time read model of the workflow."""

    @abstractmethod
    def cancel_workflow(self, workflow_id: str, reason: str = "") -> None:
        """Request cancellation of a workflow, recording an optional reason."""

    @abstractmethod
    def sleep(self, workflow_id: str, duration: timedelta) -> None:
        """Durable timer: suspend the workflow until ``duration`` has elapsed."""

    @abstractmethod
    def run_activity(
        self, name: str, input: dict[str, Any], retry_policy: RetryPolicy | None = None
    ) -> Any:
        """Execute a named activity (the side-effect boundary) with retries.

        Called from within a workflow's execution; the backend resolves the
        current workflow from execution context. Idempotent at the
        ``(workflow, activity_name, input)`` level — a replayed activity returns
        its previously recorded result instead of re-executing the side effect.
        """

    @abstractmethod
    def get_history(self, workflow_id: str) -> list[HistoryEvent]:
        """Return the workflow's ordered, append-only history."""
