"""Public service layer for workflow execution (ADR-0080 §Implementation Notes 4).

All workflow starts, signals, queries, and inspections from view or consumer code
go through these module-level functions. They resolve the configured backend and
delegate. Never import or instantiate a backend class directly — the indirection
here is what keeps consumer code backend-neutral (ADR-0080 §E).
"""

from __future__ import annotations

from datetime import timedelta
from functools import lru_cache
from typing import Any

from django.conf import settings
from django.utils.module_loading import import_string

from trueppm_api.workflows.interface import (
    HistoryEvent,
    RetryPolicy,
    WorkflowBackend,
    WorkflowState,
)

DEFAULT_BACKEND = "trueppm_api.workflows.backends.default.DefaultWorkflowBackend"


@lru_cache(maxsize=1)
def get_backend() -> WorkflowBackend:
    """Resolve and cache the configured workflow backend.

    Reads ``settings.WORKFLOW_BACKEND`` (a dotted path to a
    :class:`~trueppm_api.workflows.interface.WorkflowBackend` subclass),
    defaulting to the outbox-composing default backend. Cached for the process
    lifetime; tests that swap backends must call ``get_backend.cache_clear()``.
    """
    dotted = getattr(settings, "WORKFLOW_BACKEND", DEFAULT_BACKEND)
    backend_cls: type[WorkflowBackend] = import_string(dotted)
    return backend_cls()


def start_workflow(
    name: str,
    input: dict[str, Any],
    *,
    idempotency_key: str | None = None,
    wait_for_completion: bool = False,
) -> str:
    """Start a workflow; see :meth:`WorkflowBackend.start_workflow`."""
    return get_backend().start_workflow(
        name,
        input,
        idempotency_key=idempotency_key,
        wait_for_completion=wait_for_completion,
    )


def signal_workflow(workflow_id: str, signal: str, payload: dict[str, Any]) -> None:
    """Deliver a signal; see :meth:`WorkflowBackend.signal_workflow`."""
    get_backend().signal_workflow(workflow_id, signal, payload)


def query_workflow(workflow_id: str, query: str, args: dict[str, Any]) -> Any:
    """Query a workflow; see :meth:`WorkflowBackend.query_workflow`."""
    return get_backend().query_workflow(workflow_id, query, args)


def get_workflow_state(workflow_id: str) -> WorkflowState:
    """Fetch workflow state; see :meth:`WorkflowBackend.get_workflow_state`."""
    return get_backend().get_workflow_state(workflow_id)


def cancel_workflow(workflow_id: str, reason: str = "") -> None:
    """Cancel a workflow; see :meth:`WorkflowBackend.cancel_workflow`."""
    get_backend().cancel_workflow(workflow_id, reason)


def sleep(workflow_id: str, duration: timedelta) -> None:
    """Durable sleep; see :meth:`WorkflowBackend.sleep`."""
    get_backend().sleep(workflow_id, duration)


def run_activity(name: str, input: dict[str, Any], retry_policy: RetryPolicy | None = None) -> Any:
    """Run an activity; see :meth:`WorkflowBackend.run_activity`."""
    return get_backend().run_activity(name, input, retry_policy)


def get_history(workflow_id: str) -> list[HistoryEvent]:
    """Fetch history; see :meth:`WorkflowBackend.get_history`."""
    return get_backend().get_history(workflow_id)
