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
(bare ``raise``); ``try`` and ``try``/``except*`` are treated alike.
``contextlib.suppress(Exception)`` in a loop is flagged too.
A new unguarded loop anywhere fails here. Exempt functions live in ``_EXEMPT``
with an exact handler count and a reason; some are *known* unguarded and tracked
in #4421, so green here means "no NEW unguarded handler", not "every task-module
loop is covered". Handlers outside a loop are only seen if listed in
``_NON_LOOP_HELPERS`` or ``_EXEMPT``.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "trueppm_api"

# Handlers outside a loop that sit on a task's per-item path. Contract list: the
# loop rule cannot see them, so each is named here and asserted guarded.
_NON_LOOP_HELPERS = {("apps/scheduling/services.py", "safe_capture_forecast_snapshot")}

# Exempt handlers, keyed by (file, function) -> (handler count, reason). The count
# is exact: a new unguarded handler in an exempt function fails, and so does a
# stale entry (function renamed or removed, or the handler became guarded).
# Two kinds, split by the reason text:
#   - not task-reachable: the soft limit cannot fire there.
#   - "KNOWN-UNGUARDED #4421": reachable from a task and still swallowing the
#     signal; re-raising there changes behavior (a PurgeRun left RUNNING, a saga
#     rollback undone inside the surrounding transaction) or needs a helper
#     redesign, so it is tracked rather than fixed. Also tracked there and NOT
#     seen by this scan: projects/receivers.py receivers and
#     core/extension_signals send_robust.
_EXEMPT: dict[tuple[str, str], tuple[int, str]] = {
    ("apps/agents/deferred.py", "drain_agent_actions"): (1, "request-path drain"),
    ("apps/integrations/me_work.py", "_maybe_enqueue_on_open_refresh"): (1, "request path"),
    ("apps/notifications/email_health.py", "_txt_records"): (2, "admin request path (DNS)"),
    ("apps/observability/otel/instrumentation.py", "reset_for_testing"): (1, "test helper"),
    ("apps/projects/views.py", "_bulk_scope_change"): (1, "request path"),
    ("apps/sync/conflict.py", "_payload_changed_fields"): (2, "request path, no I/O"),
    ("apps/sync/consumers.py", "_presence_keepalive"): (1, "ASGI consumer, not a worker"),
    ("core/idempotent.py", "_run"): (1, "lock-extender thread; signal fires on main thread"),
    ("apps/projects/seed/importer.py", "_refresh_active_sprint_burndown"): (
        1,
        "KNOWN-UNGUARDED #4421 (seed import)",
    ),
    ("apps/projects/seed/replay.py", "_snapshot_active_sprints"): (
        1,
        "KNOWN-UNGUARDED #4421 (seed replay)",
    ),
    ("apps/observability/tasks.py", "_execute_run"): (
        1,
        "KNOWN-UNGUARDED #4421: re-raise would leave PurgeRun RUNNING and lose results",
    ),
    ("apps/workflow_engine/tasks.py", "_handle_failure"): (
        1,
        "KNOWN-UNGUARDED #4421: re-raise inside _do_advance's atomic undoes the rollback",
    ),
    ("apps/notifications/tasks.py", "_send_email_for_notification"): (
        1,
        "KNOWN-UNGUARDED #4421: swallows the signal, so the drain loop's guard is moot",
    ),
    ("apps/workspace/tasks.py", "_send_invite_email"): (
        1,
        "KNOWN-UNGUARDED #4421: swallows the signal, so the drain loop's guard is moot",
    ),
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
    if handler.type is None:
        return False
    names = (
        [ast.unparse(e) for e in handler.type.elts]
        if isinstance(handler.type, ast.Tuple)
        else [ast.unparse(handler.type)]
    )
    if not any(n.split(".")[-1] == "SoftTimeLimitExceeded" for n in names):
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
        if not isinstance(node, ast.Try | ast.TryStar):
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


def _counts(path: Path) -> dict[str, int]:
    """Unguarded broad handlers per function, scanning exempt/helper functions too."""
    rel = _rel(path)
    helpers = {fn for (r, fn) in _EXEMPT if r == rel} | {
        fn for (r, fn) in _NON_LOOP_HELPERS if r == rel
    }
    counts: dict[str, int] = {}
    for _, fn in violations_in(path.read_text(), helpers=helpers):
        counts[fn] = counts.get(fn, 0) + 1
    return counts


def test_no_unguarded_per_item_handler_in_any_module() -> None:
    bad = []
    for path in _modules():
        for fn, n in _counts(path).items():
            exempt = _EXEMPT.get((_rel(path), fn))
            if exempt is None or exempt[0] != n:
                bad.append(f"{_rel(path)}:{fn} has {n} (exempt: {exempt and exempt[0]})")
    assert not bad, (
        "per-item `except Exception` / suppress(Exception) in a loop without a preceding "
        "`except SoftTimeLimitExceeded: raise` (guard it, or add to _EXEMPT with a reason): "
        + ", ".join(bad)
    )


def test_exemptions_match_the_code_exactly() -> None:
    stale = []
    for (rel, fn), (count, _reason) in _EXEMPT.items():
        actual = _counts(SRC / rel).get(fn, 0)
        if actual != count:
            stale.append(f"{rel}:{fn} declares {count}, found {actual}")
    assert not stale, f"update or remove stale exemptions: {stale}"


@pytest.mark.parametrize(("rel", "func"), sorted(_NON_LOOP_HELPERS))
def test_non_loop_helpers_on_task_paths_reraise_soft_time_limit(rel: str, func: str) -> None:
    source = (SRC / rel).read_text()
    defined = {n.name for n in ast.walk(ast.parse(source)) if isinstance(n, ast.FunctionDef)}
    assert func in defined, f"{rel}:{func} no longer exists; update _NON_LOOP_HELPERS"
    bad = violations_in(source, helpers={func})
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
    trystar = _t("        try:\n            f(x)\n        except* Exception:\n            pass\n")
    trystar_guarded = _t(
        "        try:\n            f(x)\n"
        "        except* SoftTimeLimitExceeded:\n            raise\n"
        "        except* Exception:\n            pass\n"
    )
    suppress_narrow = _t("        with contextlib.suppress(KeyError):\n            f(x)\n")
    assert violations_in(unguarded) == [(5, "t")]
    assert violations_in(guarded) == []
    assert violations_in(wrong_order) == [(5, "t")]
    assert violations_in(bare_reraise) == []
    assert violations_in(suppressed) == [(3, "t")]
    assert violations_in(suppress_narrow) == []
    assert violations_in(trystar) == [(5, "t")]
    assert violations_in(trystar_guarded) == []
