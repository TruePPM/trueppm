"""Per-item ``except Exception`` in a Celery task module must not swallow the time limit.

``SoftTimeLimitExceeded`` subclasses ``Exception``. A loop that isolates per-item
failures with a bare ``except Exception`` therefore also isolates the task-level
soft limit: the item is logged as an ordinary failure and the loop runs on until
the hard kill, silently truncating a nightly sweep (#4381).

The rule enforced here, over **every** module under ``trueppm_api`` (not only
``tasks.py`` -- helpers called from task loops live in services, digests, export
bundles and so on): inside any ``for``/``while`` loop, every ``except Exception`` /
bare ``except`` handler must be preceded, in the same ``try``, by
``except SoftTimeLimitExceeded: raise``, unless the handler itself re-raises
(bare ``raise``). ``contextlib.suppress(Exception)`` in a loop is flagged too.
A new unguarded loop anywhere fails here; a loop that genuinely can never run
inside a Celery task is listed in ``_NOT_TASK_REACHABLE`` with its reason.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "trueppm_api"

# Handlers outside a loop that sit on a task's per-item path. Contract list: the
# loop rule cannot see them, so each is named here and asserted guarded.
_NON_LOOP_HELPERS = {("apps/scheduling/services.py", "safe_capture_forecast_snapshot")}

# Loops that are not reachable from a Celery task, so the soft limit cannot fire
# inside them. Each needs a reason; a stale entry fails the test below.
_NOT_TASK_REACHABLE = {
    ("apps/agents/deferred.py", "drain_agent_actions"): "request-path drain",
    ("apps/integrations/me_work.py", "_maybe_enqueue_on_open_refresh"): "request path",
    ("apps/notifications/email_health.py", "_txt_records"): "admin request path (DNS lookup)",
    ("apps/observability/otel/instrumentation.py", "reset_for_testing"): "test helper",
    ("apps/projects/seed/importer.py", "_refresh_active_sprint_burndown"): "seed command",
    ("apps/projects/seed/replay.py", "_snapshot_active_sprints"): "seed command",
    ("apps/projects/views.py", "_bulk_scope_change"): "request path",
    ("apps/sync/conflict.py", "_payload_changed_fields"): "request path, no I/O",
    ("apps/sync/consumers.py", "_presence_keepalive"): "ASGI consumer, not a worker",
    ("core/idempotent.py", "_run"): "lock-extender thread; the signal fires on the main thread",
}

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


def _reraises(handler: ast.ExceptHandler) -> bool:
    return any(isinstance(stmt, ast.Raise) and stmt.exc is None for stmt in handler.body)


def _reraises_soft_limit(handler: ast.ExceptHandler) -> bool:
    if handler.type is None or "SoftTimeLimitExceeded" not in ast.unparse(handler.type):
        return False
    return _reraises(handler)


def _suppresses_exception(node: ast.With) -> bool:
    for item in node.items:
        call = item.context_expr
        if (
            isinstance(call, ast.Call)
            and ast.unparse(call.func).split(".")[-1] == "suppress"
            and any(ast.unparse(a).split(".")[-1] in _BROAD for a in call.args)
        ):
            return True
    return False


def _context(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> tuple[bool, str]:
    in_loop = False
    fn = "<module>"
    cur = node
    while cur in parents:
        cur = parents[cur]
        if isinstance(cur, ast.For | ast.While | ast.AsyncFor):
            in_loop = True
        if isinstance(cur, ast.FunctionDef | ast.AsyncFunctionDef):
            fn = cur.name
            break
    return in_loop, fn


def violations_in(source: str, *, helpers: set[str] | None = None) -> list[tuple[int, str]]:
    """Return ``(lineno, function)`` for each unguarded broad handler in scope."""
    tree = ast.parse(source)
    parents: dict[ast.AST, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.With) and _suppresses_exception(node):
            in_loop, fn = _context(node, parents)
            if in_loop or (helpers and fn in helpers):
                found.append((node.lineno, fn))
            continue
        if not isinstance(node, ast.Try):
            continue
        in_loop, fn = _context(node, parents)
        if not (in_loop or (helpers and fn in helpers)):
            continue
        guarded = False
        for handler in node.handlers:
            if _reraises_soft_limit(handler):
                guarded = True
            elif _is_broad(handler) and not guarded and not _reraises(handler):
                found.append((handler.lineno, fn))
    return found


def _modules() -> list[Path]:
    return sorted(p for p in SRC.rglob("*.py") if "migrations" not in p.parts)


def _rel(path: Path) -> str:
    return path.relative_to(SRC).as_posix()


def test_no_unguarded_per_item_handler_in_any_module() -> None:
    bad = []
    for path in _modules():
        for lineno, fn in violations_in(path.read_text()):
            if (_rel(path), fn) not in _NOT_TASK_REACHABLE:
                bad.append(f"{_rel(path)}:{lineno} in {fn}")
    assert not bad, (
        "per-item `except Exception` / suppress(Exception) in a loop without a preceding "
        "`except SoftTimeLimitExceeded: raise` (or add to _NOT_TASK_REACHABLE with a reason): "
        + ", ".join(bad)
    )


def test_not_task_reachable_list_has_no_stale_entries() -> None:
    live = {(_rel(p), fn) for p in _modules() for _, fn in violations_in(p.read_text())}
    stale = set(_NOT_TASK_REACHABLE) - live
    assert not stale, f"remove entries that no longer need an exemption: {sorted(stale)}"


@pytest.mark.parametrize(("rel", "func"), sorted(_NON_LOOP_HELPERS))
def test_non_loop_helpers_on_task_paths_reraise_soft_time_limit(rel: str, func: str) -> None:
    bad = violations_in((SRC / rel).read_text(), helpers={func})
    assert not [b for b in bad if b[1] == func], f"{rel}:{func} swallows SoftTimeLimitExceeded"


def _t(body: str) -> str:
    return "def t():\n    for x in xs:\n" + body


def test_negative_controls() -> None:
    unguarded = _t("        try:\n            f(x)\n        except Exception:\n            pass\n")
    guarded = _t(
        "        try:\n            f(x)\n        except SoftTimeLimitExceeded:\n            raise\n"
        "        except Exception:\n            pass\n"
    )
    wrong_order = _t(
        "        try:\n            f(x)\n        except Exception:\n            pass\n"
        "        except SoftTimeLimitExceeded:\n            raise\n"
    )
    bare_reraise = _t(
        "        try:\n            f(x)\n        except Exception:\n            raise\n"
    )
    suppressed = _t("        with contextlib.suppress(Exception):\n            f(x)\n")
    suppress_narrow = _t("        with contextlib.suppress(KeyError):\n            f(x)\n")
    assert violations_in(unguarded) == [(5, "t")]
    assert violations_in(guarded) == []
    assert violations_in(wrong_order) == [(5, "t")]
    assert violations_in(bare_reraise) == []
    assert violations_in(suppressed) == [(3, "t")]
    assert violations_in(suppress_narrow) == []
