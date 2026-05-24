"""Workflow definition registry (ADR-0080 §A).

Workflow authors register a :class:`WorkflowDefinition` under a unique name; the
engine resolves it at start time. This module is part of the backend-neutral
surface — it must never import ``celery``, ``dbos``, or ``temporalio``. A
definition describes *what* runs (an ordered chain of steps with optional
compensation, the ``TaskChain`` model from #65); the backend decides *how*.

The declarative step list is what keeps authoring backend-portable: the default
Celery+outbox backend, the DBOS adapter, and a future Temporal adapter can each
execute the same definition. See ADR-0080 §A "Authoring model".

Registration mirrors the integration ``ProviderRegistry`` pattern (ADR-0049):
OSS definitions register in ``WorkflowEngineConfig.ready()``; enterprise definitions
register from their own ``AppConfig.ready()`` — same hook, no ``if enterprise``.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

# An activity is a callable taking a context dict and returning a JSON-able
# result (or None). The engine wraps every activity execution in once-and-only-once
# semantics, so an activity must be safe to *record* once even if dispatched twice.
Activity = Callable[[dict[str, Any]], dict[str, Any] | None]

# A compensation undoes a previously-completed step during saga rollback. It
# receives the same context the step's activity received. Best-effort: failures
# are logged, not re-raised, so one failed rollback does not strand the others.
Compensation = Callable[[dict[str, Any]], None]


@dataclass(frozen=True, slots=True)
class WorkflowStep:
    """One step in a workflow's chain: an activity plus optional compensation.

    ``name`` is unique within a definition and is the activity-name half of the
    once-and-only-once key ``(workflow, activity_name, input_hash)``.
    """

    name: str
    activity: Activity
    compensate: Compensation | None = None


class WorkflowDefinition:
    """Base class for a registered workflow (ADR-0080 §A).

    Subclasses set ``name`` and implement :meth:`build_steps` to return the
    ordered chain for a given input. The v1 engine executes the chain
    sequentially, compensating completed steps in reverse on failure. Override
    :meth:`on_query` to answer ``query_workflow`` calls.
    """

    name: str

    def build_steps(self, workflow_input: dict[str, Any]) -> list[WorkflowStep]:
        """Return the ordered steps for this workflow run.

        Pure and deterministic given ``workflow_input`` — the engine may rebuild
        the chain on a redelivered step, so the same input must yield the same
        steps in the same order.
        """
        raise NotImplementedError

    def on_query(self, query: str, args: dict[str, Any]) -> Any:
        """Answer a named read-only query against the workflow (optional)."""
        raise NotImplementedError(f"workflow {self.name!r} defines no query handler")


class WorkflowRegistry:
    """Name → definition registry, mirroring integrations' ``ProviderRegistry``.

    A duplicate name raises rather than silently overwriting, so two apps cannot
    both claim a workflow name without a loud failure at registration time.
    """

    def __init__(self) -> None:
        self._registry: dict[str, WorkflowDefinition] = {}

    def register(self, definition: WorkflowDefinition) -> WorkflowDefinition:
        name = definition.name
        if name in self._registry:
            raise ValueError(f"workflow {name!r} is already registered")
        self._registry[name] = definition
        return definition

    def get(self, name: str) -> WorkflowDefinition:
        try:
            return self._registry[name]
        except KeyError:
            raise KeyError(f"no workflow registered under {name!r}") from None

    def all(self) -> dict[str, WorkflowDefinition]:
        """Return a copy of the registered definitions (used by the contract test)."""
        return dict(self._registry)

    def clear(self) -> None:
        """Reset the registry — test helper only."""
        self._registry.clear()


# Process-wide singleton. Workflow definitions register against this.
WORKFLOWS = WorkflowRegistry()
