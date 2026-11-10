"""Exported functions that raise document a ``Raises:`` section (#4100).

The check is deliberately narrow so it cannot flake: for each function in
``trueppm_scheduler.__all__`` whose *own* source contains a ``raise`` statement,
the docstring must carry a ``Raises:`` section. Exceptions raised only inside
helpers are not detected (that would need call-graph analysis); the specific
public functions the audit named are pinned explicitly below.
"""

from __future__ import annotations

import ast
import inspect
import textwrap
from typing import Any

import pytest

import trueppm_scheduler as ts


def _exported_functions() -> list[tuple[str, Any]]:
    return [(name, obj) for name in ts.__all__ if inspect.isfunction(obj := getattr(ts, name))]


def _raises_directly(fn: Any) -> bool:
    target = inspect.unwrap(fn)
    try:
        source = inspect.getsource(target)
    except (OSError, TypeError):
        pytest.skip(f"no source for {getattr(fn, '__name__', fn)!r} (wrapped or built-in)")
    tree = ast.parse(textwrap.dedent(source))
    return any(isinstance(node, ast.Raise) for node in ast.walk(tree))


@pytest.mark.parametrize(("name", "fn"), _exported_functions())
def test_exported_function_that_raises_documents_raises(name: str, fn: Any) -> None:
    if _raises_directly(fn):
        assert "Raises:" in (inspect.getdoc(fn) or ""), f"{name} raises but has no Raises: section"


@pytest.mark.parametrize("name", ["schedule", "monte_carlo", "expand_summary_dependencies"])
def test_named_functions_document_invalid_schedule_input(name: str) -> None:
    doc = inspect.getdoc(getattr(ts, name)) or ""
    assert "Raises:" in doc
    assert "InvalidScheduleInput" in doc


def test_schedule_does_not_name_bare_value_error() -> None:
    doc = inspect.getdoc(ts.schedule) or ""
    assert "ValueError:" not in doc


# Each cause #4100 listed for expand_summary_dependencies, as a phrase its docstring must carry.
_EXPAND_CAUSES = {
    "non-dict / non-string ids": "is not a dict",
    "non-list value": "value is not a list",
    "empty children list": "empty children list",
    "unknown child": "names no task",
    "children-map cycle": "parent-child cycle",
    "self-child": "its own child",
    "SS/SF from a summary": "Start-to-Start or Start-to-Finish link from a summary",
    "expansion bound": "MAX_EXPANDED_EDGES",
    "shared-leaf cycle": "CyclicDependencyError",
}


@pytest.mark.parametrize(("cause", "phrase"), list(_EXPAND_CAUSES.items()))
def test_expand_summary_dependencies_documents_each_cause(cause: str, phrase: str) -> None:
    doc = " ".join((inspect.getdoc(ts.expand_summary_dependencies) or "").split())
    assert phrase in doc, f"expand_summary_dependencies docstring does not document: {cause}"
