"""Lint: a child process with a piped stderr must drain it concurrently (#4385).

Reading stdout to EOF and only then stderr deadlocks as soon as the child writes
more than one pipe buffer (~64 KB) to stderr: the child blocks, stdout never
closes, and the worker is pinned until its timeout.

Rule, per innermost enclosing scope: a ``subprocess.Popen(..., stderr=PIPE)`` or
``asyncio.create_subprocess_exec/shell(..., stderr=PIPE)`` bound to a variable
must be drained by (a) ``<var>.communicate()``, or (b) a ``Thread`` (asyncio:
``create_task``/``ensure_future``) whose target expression, or a local function
it names, reads ``<var>.stderr``. An unrelated Thread, or ``communicate()`` on a
different process, does not count. Import aliases (``import subprocess as sp``,
``from subprocess import Popen as P, PIPE as Q``) are resolved.

Not covered: ``subprocess.run``/``check_output`` (they drain internally, so are
safe), ``stderr=<file object>`` (no pipe), a Popen handed to another function or
stored on ``self`` before draining, and ``star-import``/``getattr`` indirection.
"""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"

_FUNCS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)


class _Aliases:
    def __init__(self, tree: ast.AST) -> None:
        self.subprocess_mods: set[str] = set()
        self.asyncio_mods: set[str] = set()
        self.popen: set[str] = set()
        self.pipe: set[str] = set()
        self.async_spawn: set[str] = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                for a in n.names:
                    if a.name == "subprocess":
                        self.subprocess_mods.add(a.asname or "subprocess")
                    elif a.name == "asyncio":
                        self.asyncio_mods.add(a.asname or "asyncio")
            elif isinstance(n, ast.ImportFrom):
                for a in n.names:
                    bound = a.asname or a.name
                    if n.module == "subprocess" and a.name == "Popen":
                        self.popen.add(bound)
                    elif n.module == "subprocess" and a.name == "PIPE":
                        self.pipe.add(bound)
                    elif n.module == "asyncio" and a.name in (
                        "create_subprocess_exec",
                        "create_subprocess_shell",
                    ):
                        self.async_spawn.add(bound)

    def is_pipe(self, node: ast.expr) -> bool:
        if isinstance(node, ast.Name):
            return node.id in self.pipe
        return (
            isinstance(node, ast.Attribute)
            and node.attr == "PIPE"
            and isinstance(node.value, ast.Name)
            and node.value.id in self.subprocess_mods
        )

    def spawn_kind(self, call: ast.Call) -> str | None:
        f = call.func
        if isinstance(f, ast.Name):
            if f.id in self.popen:
                return "thread"
            if f.id in self.async_spawn:
                return "async"
        elif isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
            if f.attr == "Popen" and f.value.id in self.subprocess_mods:
                return "thread"
            if (
                f.attr in ("create_subprocess_exec", "create_subprocess_shell")
                and f.value.id in self.asyncio_mods
            ):
                return "async"
        return None


def _reads_stderr(node: ast.AST, var: str) -> bool:
    return any(
        isinstance(n, ast.Attribute)
        and n.attr == "stderr"
        and isinstance(n.value, ast.Name)
        and n.value.id == var
        for n in ast.walk(node)
    )


def _call_attr(call: ast.Call) -> str:
    f = call.func
    if isinstance(f, ast.Attribute):
        return f.attr
    if isinstance(f, ast.Name):
        return f.id
    return ""


def _drained(scope: ast.AST, var: str, kind: str) -> bool:
    local_defs = {
        n.name: n for n in ast.walk(scope) if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)
    }
    spawners = {"Thread"} if kind == "thread" else {"create_task", "ensure_future"}
    for n in ast.walk(scope):
        if not isinstance(n, ast.Call):
            continue
        f = n.func
        if (
            isinstance(f, ast.Attribute)
            and f.attr == "communicate"
            and isinstance(f.value, ast.Name)
            and f.value.id == var
        ):
            return True
        if _call_attr(n) in spawners:
            exprs: list[ast.AST] = [*n.args, *[k.value for k in n.keywords]]
            for e in exprs:
                if _reads_stderr(e, var):
                    return True
                for sub in ast.walk(e):
                    if (
                        isinstance(sub, ast.Name)
                        and sub.id in local_defs
                        and _reads_stderr(local_defs[sub.id], var)
                    ):
                        return True
    return False


def find_violations(source: str, filename: str = "<src>") -> list[str]:
    tree = ast.parse(source, filename)
    al = _Aliases(tree)
    out: set[str] = set()

    def visit(node: ast.AST, scope: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            inner = child if isinstance(child, _FUNCS) else scope
            if isinstance(child, ast.Call):
                kind = al.spawn_kind(child)
                if kind and any(k.arg == "stderr" and al.is_pipe(k.value) for k in child.keywords):
                    var = _bound_name(node, child)
                    if var is None or not _drained(scope, var, kind):
                        out.add(f"{filename}:{child.lineno}")
            visit(child, inner)

    visit(tree, tree)
    return sorted(out)


def _bound_name(parent: ast.AST, call: ast.Call) -> str | None:
    value: ast.AST | None = call
    if isinstance(parent, ast.Await):
        return None
    if isinstance(parent, ast.Assign) and parent.value is call:
        t = parent.targets[0]
        return t.id if isinstance(t, ast.Name) else None
    if isinstance(parent, ast.AnnAssign) and parent.value is call:
        return parent.target.id if isinstance(parent.target, ast.Name) else None
    if isinstance(parent, ast.withitem) and parent.context_expr is call:
        v = parent.optional_vars
        return v.id if isinstance(v, ast.Name) else None
    del value
    return None


def test_no_unsafe_piped_stderr_in_src() -> None:
    violations: list[str] = []
    for path in SRC.rglob("*.py"):
        violations += find_violations(path.read_text(), str(path.relative_to(SRC)))
    assert not violations, (
        "child process with stderr=PIPE and no concurrent drain (communicate() "
        f"or a Thread reading that process's stderr) can deadlock: {violations}"
    )


_HEAD = "import subprocess, threading\n"


def _v(src: str) -> list[str]:
    return find_violations(src)


def test_flags_sequential_read() -> None:
    src = _HEAD + (
        "def f():\n"
        "    p = subprocess.Popen(['x'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)\n"
        "    p.stdout.read()\n"
        "    p.stderr.read()\n"
    )
    assert _v(src) == ["<src>:3"]


def test_flags_aliased_imports() -> None:
    assert _v("import subprocess as sp\nq = sp.Popen(['x'], stderr=sp.PIPE)\n") == ["<src>:2"]
    assert _v("from subprocess import Popen as P, PIPE as Q\nq = P(['x'], stderr=Q)\n") == [
        "<src>:2"
    ]
    assert _v(
        "from subprocess import Popen\nimport subprocess\n"
        "q = Popen(['x'], stderr=subprocess.PIPE)\n"
    ) == ["<src>:3"]


def test_unrelated_thread_or_communicate_does_not_silence() -> None:
    other_thread = _HEAD + (
        "def f():\n"
        "    p = subprocess.Popen(['x'], stderr=subprocess.PIPE)\n"
        "    threading.Thread(target=print).start()\n"
    )
    other_comm = _HEAD + (
        "def f(o):\n    p = subprocess.Popen(['x'], stderr=subprocess.PIPE)\n    o.communicate()\n"
    )
    other_proc_stderr = _HEAD + (
        "def f(o):\n"
        "    p = subprocess.Popen(['x'], stderr=subprocess.PIPE)\n"
        "    threading.Thread(target=o.stderr.read).start()\n"
    )
    assert _v(other_thread) == ["<src>:3"]
    assert _v(other_comm) == ["<src>:3"]
    assert _v(other_proc_stderr) == ["<src>:3"]


def test_module_level_checked_per_statement_not_whole_file() -> None:
    src = _HEAD + (
        "p = subprocess.Popen(['x'], stderr=subprocess.PIPE)\n"
        "def g():\n"
        "    r = subprocess.Popen(['y'], stderr=subprocess.PIPE)\n"
        "    r.communicate()\n"
    )
    assert _v(src) == ["<src>:2"]


def test_flags_asyncio_spawn() -> None:
    src = (
        "import asyncio\n"
        "async def f():\n"
        "    p = await asyncio.create_subprocess_exec('x', stderr=asyncio.subprocess.PIPE)\n"
    )
    # asyncio.subprocess.PIPE is not a subprocess-module PIPE alias here; use the real form.
    src2 = (
        "import asyncio, subprocess\n"
        "async def f():\n"
        "    p = await asyncio.create_subprocess_exec('x', stderr=subprocess.PIPE)\n"
    )
    del src
    assert _v(src2) == ["<src>:3"]


def test_accepts_correct_drains() -> None:
    thread_direct = _HEAD + (
        "def f():\n"
        "    p = subprocess.Popen(['x'], stderr=subprocess.PIPE)\n"
        "    threading.Thread(target=p.stderr.read).start()\n"
    )
    thread_local_fn = _HEAD + (
        "def f():\n"
        "    p = subprocess.Popen(['x'], stderr=subprocess.PIPE)\n"
        "    def drain():\n"
        "        p.stderr.read(10)\n"
        "    threading.Thread(target=drain).start()\n"
    )
    comm = _HEAD + (
        "def f():\n"
        "    with subprocess.Popen(['x'], stderr=subprocess.PIPE) as p:\n"
        "        p.communicate()\n"
    )
    no_pipe = _HEAD + "def f():\n    subprocess.Popen(['x'], stderr=subprocess.DEVNULL)\n"
    for src in (thread_direct, thread_local_fn, comm, no_pipe):
        assert _v(src) == []
