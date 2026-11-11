"""Public service layer for workflow execution (ADR-0080 §Implementation Notes 4).

All workflow starts, signals, queries, and inspections from view or consumer code
go through these module-level functions. They resolve the configured backend and
delegate. Never import or instantiate a backend class directly — the indirection
here is what keeps consumer code backend-neutral (ADR-0080 §E).
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Callable
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

logger = logging.getLogger(__name__)

# Backend classes already warned about ignoring ``restart_failed``. The warning
# is a configuration fact, not a per-request event, so it is logged once per
# process instead of on every requeue.
_warned_legacy_backends: set[type[Any]] = set()


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
    restart_failed: bool = False,
) -> str:
    """Start a workflow; see :meth:`WorkflowBackend.start_workflow`.

    ``WORKFLOW_BACKEND`` is an extension point, and a backend written against
    the signature that predates ``restart_failed`` (#2994) does not accept it.
    The flag is therefore forwarded only when it is true *and* the backend's
    ``start_workflow`` can take it. Against a legacy backend a restart request
    degrades to a plain start — the backend's own behavior for an existing key,
    which is what every requeue got before #2994 — and a warning is logged once
    per process per backend class, so an operator's requeue still succeeds
    instead of raising ``TypeError``.

    The capability is read from the signature rather than by catching
    ``TypeError`` and retrying: a ``TypeError`` raised *inside* a backend would
    otherwise run the start a second time.
    """
    backend = get_backend()
    extra: dict[str, Any] = {}
    if restart_failed:
        if _accepts_kwarg(backend.start_workflow, "restart_failed"):
            extra["restart_failed"] = True
        elif type(backend) not in _warned_legacy_backends:
            _warned_legacy_backends.add(type(backend))
            logger.warning(
                "start_workflow: backend %s does not accept restart_failed; starting %r "
                "without it, so a FAILED instance under this key is returned unchanged "
                "(logged once per process)",
                type(backend).__name__,
                name,
            )
    return backend.start_workflow(
        name,
        input,
        idempotency_key=idempotency_key,
        wait_for_completion=wait_for_completion,
        **extra,
    )


def _accepts_kwarg(func: Callable[..., Any], kwarg: str) -> bool:
    """True when ``func`` takes ``kwarg`` by name, explicitly or via ``**kwargs``."""
    try:
        params = inspect.signature(func).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(
        p.kind is inspect.Parameter.VAR_KEYWORD
        or (p.name == kwarg and p.kind is not inspect.Parameter.POSITIONAL_ONLY)
        for p in params
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


def in_flight_idempotency_keys(idempotency_keys: list[str]) -> set[str]:
    """Keys whose workflow is still running; see the backend method."""
    return get_backend().in_flight_idempotency_keys(idempotency_keys)
