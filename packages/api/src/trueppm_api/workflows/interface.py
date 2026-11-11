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


class NonRetryableError(Exception):
    """Raised by an activity to say that running it again cannot succeed.

    The default backend retries any other exception up to a bounded budget before
    it gives up and rolls the workflow back. Raise this one for a failure nothing
    can fix (a malformed input, a target that no longer exists) so the workflow
    fails at once instead of spending attempts it cannot use.
    """


class RestartRefusedError(RuntimeError):
    """Raised by ``start_workflow(restart_failed=True)`` when a re-run is unsafe.

    The restart replays from step 0, and completed steps return their cached
    results, so it resumes at the failed step. Once the saga rollback has
    compensated a step, its cached result stands in for a side effect that is
    gone, so a workflow that ran compensation is refused a restart. The default
    backend records that fact outside the purgeable history, so the refusal
    survives ``WORKFLOW_HISTORY_RETENTION_DAYS``. The caller must start a fresh
    workflow under a new idempotency key instead.
    """


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
        restart_failed: bool = False,
    ) -> str:
        """Start a workflow and return its id.

        ``restart_failed=True`` re-runs an existing instance that ended ``FAILED``
        under the same ``idempotency_key`` instead of returning it untouched. Without
        it a failed workflow is terminal for its key, so an operator's retry of the
        same logical request would silently be a no-op. The re-run replays from
        step 0 and steps that already completed are served from the
        once-and-only-once cache, so it resumes at the failed step. A workflow
        whose rollback ran compensation is refused with
        :class:`RestartRefusedError` — even after its history has been purged —
        because a cached result would stand in for an undone side effect.

        Backends that predate this flag need not accept it. The service layer
        (``workflows.services.start_workflow``) forwards it only when it is true
        and this method's signature accepts it (by name or ``**kwargs``); against
        a backend that does not, it starts without the flag and logs a warning, so
        a FAILED instance under the key comes back unchanged rather than the call
        raising ``TypeError``. A backend that wants restarts must add the keyword.

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

    def in_flight_idempotency_keys(self, idempotency_keys: list[str]) -> set[str]:
        """Return the subset of ``idempotency_keys`` whose workflow has not finished.

        Lets a caller skip work it already started without a marker of its own.
        Deliberately not abstract, so a backend written before it existed keeps
        working: the default answers "none in flight", which costs that caller
        only a wasted re-start that the idempotency key already de-duplicates.
        """
        return set()
