"""Lint: a ``Popen`` with a piped stderr must drain it concurrently (#4385).

Reading stdout to EOF and only then stderr deadlocks as soon as the child writes
more than one pipe buffer (~64 KB) to stderr: the child blocks, stdout never
closes, and the worker is pinned until its timeout. The rule, checked per
enclosing function: a ``Popen(..., stderr=PIPE)`` must sit beside a
``communicate()`` call or a ``threading.Thread`` drain.
"""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"


def _is_pipe(node: ast.expr) -> bool:
    return (isinstance(node, ast.Attribute) and node.attr == "PIPE") or (
        isinstance(node, ast.Name) and node.id == "PIPE"
    )


def _called_name(call: ast.Call) -> str:
    f = call.func
    if isinstance(f, ast.Attribute):
        return f.attr
    if isinstance(f, ast.Name):
        return f.id
    return ""


def find_violations(source: str, filename: str = "<src>") -> list[str]:
    tree = ast.parse(source, filename)
    out: list[str] = []
    scopes: list[ast.AST] = [tree] + [
        n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)
    ]
    for scope in scopes:
        calls = [n for n in ast.walk(scope) if isinstance(n, ast.Call)]
        names = {_called_name(c) for c in calls}
        drains = bool(names & {"communicate", "Thread"})
        for c in calls:
            if _called_name(c) != "Popen":
                continue
            if not any(k.arg == "stderr" and _is_pipe(k.value) for k in c.keywords):
                continue
            if not drains:
                out.append(f"{filename}:{c.lineno}")
    return sorted(set(out))


def test_no_popen_with_undrained_stderr_pipe() -> None:
    violations: list[str] = []
    for path in SRC.rglob("*.py"):
        violations += find_violations(path.read_text(), str(path.relative_to(SRC)))
    assert not violations, (
        "Popen(stderr=PIPE) without a concurrent drain (communicate() or a "
        f"Thread) can deadlock on a chatty child: {violations}"
    )


def test_rule_flags_sequential_read() -> None:
    bad = (
        "import subprocess\n"
        "def f():\n"
        "    p = subprocess.Popen(['x'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)\n"
        "    p.stdout.read()\n"
        "    p.stderr.read()\n"
    )
    assert find_violations(bad) == ["<src>:3"]


def test_rule_accepts_thread_drain_and_communicate() -> None:
    ok_thread = (
        "import subprocess, threading\n"
        "def f():\n"
        "    p = subprocess.Popen(['x'], stderr=subprocess.PIPE)\n"
        "    threading.Thread(target=p.stderr.read).start()\n"
    )
    ok_comm = (
        "import subprocess\n"
        "def f():\n"
        "    p = subprocess.Popen(['x'], stderr=subprocess.PIPE)\n"
        "    p.communicate()\n"
    )
    assert find_violations(ok_thread) == []
    assert find_violations(ok_comm) == []
