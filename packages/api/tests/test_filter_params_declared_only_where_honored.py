"""Every operation that publishes ``search`` / ``ordering`` must actually honor them (#3452).

``SearchFilter`` and ``OrderingFilter`` are in ``DEFAULT_FILTER_BACKENDS``, so
drf-spectacular publishes both parameters on every list-shaped operation, including
custom ``@action``s and hand-written ``list``/``create`` methods that build their own
querysets and never call ``filter_queryset()``. The parameter is then accepted,
documented and dropped on the floor — worse than a 400, because nothing signals that it
did nothing. #3420 swept ``ProgramViewSet`` only; this walks the whole generated schema.

The generated schema is the subject because the failure mode is a *published*
parameter, but the schema alone cannot say whether a handler filters. So each operation
is mapped back to the view and handler that produced it (by recording
``AutoSchema.get_operation``), and the handler's source is parsed for a real
``filter_queryset(...)`` call — a comment that merely names the method does not count.
"""

from __future__ import annotations

import ast
import inspect
import textwrap
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from drf_spectacular.generators import SchemaGenerator
from drf_spectacular.openapi import AutoSchema
from rest_framework.mixins import ListModelMixin

FILTER_PARAMS = {"search", "ordering"}


def _calls_filter_queryset(handler: Callable[..., Any]) -> bool:
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(handler)))
    except (OSError, TypeError, SyntaxError):
        return False
    return any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "filter_queryset"
        for node in ast.walk(tree)
    )


def _operations(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, Any, dict[str, Any]]]:
    """Generate the schema, returning ``(http_method, view, operation)`` per operation."""
    recorded: list[tuple[str, Any, dict[str, Any]]] = []
    original = AutoSchema.get_operation

    def record(self: AutoSchema, *args: Any, **kwargs: Any) -> Any:
        operation = original(self, *args, **kwargs)
        if operation:
            recorded.append((self.method, self.view, operation))
        return operation

    monkeypatch.setattr(AutoSchema, "get_operation", record)
    SchemaGenerator().get_schema(request=None, public=True)
    return recorded


def _declared(operation: dict[str, Any]) -> set[str]:
    return {
        p["name"]
        for p in operation.get("parameters", [])
        if p.get("in") == "query" and p["name"] in FILTER_PARAMS
    }


def _handler(method: str, view: Any) -> Callable[..., Any] | None:
    action = getattr(view, "action", None)
    if action is None and method == "GET" and isinstance(view, ListModelMixin):
        # A plain generics.ListAPIView: `get` -> `list`.
        action = "list"
    return getattr(type(view), action or method.lower(), None)


def _honors(handler: Callable[..., Any] | None) -> bool:
    if handler is None:
        return False
    return getattr(handler, "__qualname__", "").startswith("ListModelMixin.") or (
        _calls_filter_queryset(handler)
    )


def _offenders(operations: list[tuple[str, Any, dict[str, Any]]]) -> Iterator[str]:
    for method, view, operation in operations:
        declared = _declared(operation)
        if not declared:
            continue
        label = f"{method} {operation['operationId']} ({type(view).__name__})"
        if not _honors(_handler(method, view)):
            yield f"{label} declares {sorted(declared)} but never calls filter_queryset()"
        elif "search" in declared and not getattr(view, "search_fields", None):
            yield f"{label} declares `search` but the view has no search_fields"


def test_filter_params_are_declared_only_where_they_are_honored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    operations = _operations(monkeypatch)

    declaring = [op for _, _, op in operations if _declared(op)]
    # Non-zero denominators: a mapping bug here would otherwise sweep nothing and pass,
    # which is the vacuous-guard failure this whole issue is an instance of. The
    # honoring side is the more important of the two — an over-broad undeclare must not
    # be able to satisfy this test by hiding every working parameter.
    assert len(declaring) >= 40, f"only {len(declaring)} operations declare search/ordering"
    assert len(operations) >= 300, f"only {len(operations)} operations generated"

    offenders = sorted(_offenders(operations))
    assert not offenders, (
        "\n".join(offenders)
        + "\n\nEither honor the parameters (`qs = self.filter_queryset(qs)`, AFTER any "
        "hardcoded .order_by) or undeclare them with "
        "`@extend_schema(parameters=UNDECLARE_FILTER_PARAMS)` "
        "(trueppm_api.core.openapi). `parameters=[]` removes nothing."
    )


def test_known_honoring_and_dishonoring_operations_are_classified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pin both directions so the classifier itself cannot rot into 'everything passes'."""
    by_id = {op["operationId"]: (m, v, op) for m, v, op in _operations(monkeypatch)}

    # Honors (ListModelMixin / explicit filter_queryset) -> still published.
    for operation_id in ("v1_projects_list", "v1_tasks_list", "v1_programs_projects_list"):
        method, view, operation = by_id[operation_id]
        assert {"search", "ordering"} <= _declared(operation), operation_id
        assert _honors(_handler(method, view)), operation_id

    # Never filters -> must be undeclared (these were the declared-but-ignored set).
    for operation_id in (
        "v1_projects_export_jobs_list",
        "v1_projects_trash_list",
        "v1_tasks_search_list",
        "v1_me_credentials_create",
        "v1_me_notification_preferences_apply_preset_create",
    ):
        method, view, operation = by_id[operation_id]
        assert not _honors(_handler(method, view)), operation_id
        assert not _declared(operation), operation_id
