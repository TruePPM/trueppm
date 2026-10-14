"""Per-item ``except Exception`` in a Celery task module must not swallow the time limit.

``SoftTimeLimitExceeded`` subclasses ``Exception``. A loop that isolates per-item
failures with a bare ``except Exception`` therefore also isolates the task-level
soft limit: the item is logged as an ordinary failure and the loop runs on until
the hard kill, silently truncating a nightly sweep (#4381).

The rule enforced here: inside any ``for``/``while`` loop in a task module (or the
named helper below), every ``except Exception`` / bare ``except`` handler must be
preceded, in the same ``try``, by ``except SoftTimeLimitExceeded: raise`` (or a
handler that re-raises it as a bare ``raise``).
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "trueppm_api"

# Service helpers called from task loops that wrap work in a best-effort catch.
# Their handlers sit outside a loop, so they are listed explicitly.
_HELPER_FUNCTIONS = {("apps/scheduling/services.py", "safe_capture_forecast_snapshot")}

_BROAD = {"Exception", "BaseException"}


def _is_broad(handler: ast.ExceptHandler) -> bool:
    if handler.type is None:
        return True
    names = (
        [ast.unparse(e) for e in handler.type.elts]
        if isinstance(handler.type, ast.Tuple)
        else [ast.unparse(handler.type)]
    )
    return any(n.split(".")[-1] in _BROAD for n in names)


def _reraises_soft_limit(handler: ast.ExceptHandler) -> bool:
    if handler.type is None:
        return False
    if "SoftTimeLimitExceeded" not in ast.unparse(handler.type):
        return False
    return any(isinstance(stmt, ast.Raise) and stmt.exc is None for stmt in handler.body)


def violations_in(source: str, *, helpers: set[str] | None = None) -> list[tuple[int, str]]:
    """Return ``(lineno, function)`` for each unguarded broad handler in scope."""
    tree = ast.parse(source)
    parents: dict[ast.AST, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        in_loop = False
        fn = "<module>"
        cur: ast.AST = node
        while cur in parents:
            cur = parents[cur]
            if isinstance(cur, ast.For | ast.While | ast.AsyncFor):
                in_loop = True
            if isinstance(cur, ast.FunctionDef | ast.AsyncFunctionDef):
                fn = cur.name
                break
        if not (in_loop or (helpers and fn in helpers)):
            continue
        guarded = False
        for handler in node.handlers:
            if _reraises_soft_limit(handler):
                guarded = True
            elif _is_broad(handler) and not guarded:
                found.append((handler.lineno, fn))
    return found


def _task_files() -> list[Path]:
    return sorted((SRC / "apps").glob("*/tasks.py"))


@pytest.mark.parametrize("path", _task_files(), ids=lambda p: p.parent.name)
def test_task_loops_reraise_soft_time_limit(path: Path) -> None:
    bad = violations_in(path.read_text())
    assert not bad, (
        f"{path.relative_to(SRC)}: per-item `except Exception` in a loop without a preceding "
        f"`except SoftTimeLimitExceeded: raise` at (line, function) {bad}"
    )


@pytest.mark.parametrize(("rel", "func"), sorted(_HELPER_FUNCTIONS))
def test_helpers_called_from_task_loops_reraise_soft_time_limit(rel: str, func: str) -> None:
    bad = violations_in((SRC / rel).read_text(), helpers={func})
    assert not [b for b in bad if b[1] == func], (
        f"{rel}:{func} swallows SoftTimeLimitExceeded {bad}"
    )


def test_negative_control_unguarded_handler_is_flagged() -> None:
    unguarded = (
        "def t():\n    for x in xs:\n        try:\n            f(x)\n"
        "        except Exception:\n            pass\n"
    )
    guarded = (
        "def t():\n    for x in xs:\n        try:\n            f(x)\n"
        "        except SoftTimeLimitExceeded:\n            raise\n"
        "        except Exception:\n            pass\n"
    )
    wrong_order = (
        "def t():\n    for x in xs:\n        try:\n            f(x)\n"
        "        except Exception:\n            pass\n"
        "        except SoftTimeLimitExceeded:\n            raise\n"
    )
    assert violations_in(unguarded) == [(5, "t")]
    assert violations_in(guarded) == []
    assert violations_in(wrong_order) == [(5, "t")]
