#!/usr/bin/env python3
"""Catch a ``bulk_create`` of a ``VersionedModel`` that leaves ``server_version = 0``.

Why this exists
---------------
``bulk_create`` never calls ``Model.save()``, so ``VersionedModel.save()``'s INSERT
path -- the one that sets ``server_version = 1`` -- does not run. A row inserted that
way publishes ``server_version = 0``: an optimistic-lock token no client can have
echoed back as ``X-Base-Version``, and the counter ``apps/sync/conflict.py`` slices
``current - base_version`` history rows on.

The mechanism was already understood for the *other* counter. Four of the sites this
gate first found sat directly below a comment carefully explaining why ``sync_seq``
must be set by hand (ADR-0686). The reasoning was written once for one counter and
never widened to the class, and nothing -- not ruff, not ``api:migration-check``,
which never opens a database -- could see the second counter missing. This is that
gate. It is pure static analysis: no Django, no database, no dependency install.

The rule
--------
Every ``<Model>.objects.bulk_create(...)`` (or ``<Model>._default_manager...``) where
``<Model>`` is, transitively, a subclass of ``VersionedModel`` must sit in a scope
(the enclosing function, or the module for top-level code) that sets
``server_version``: a ``server_version=`` keyword on a constructor call, or an
assignment to a ``.server_version`` attribute (including ``+=``). Otherwise it needs
a ``# safe-bulk-create: <reason>`` comment inside the call or in the comment block
directly above it.

What this gate cannot see
-------------------------
It is a lint, and it says so rather than implying it sees everything:

* **Receivers it cannot resolve.** ``model.objects.bulk_create`` where ``model`` is a
  variable, a ``getattr``, or ``apps.get_model(...)`` is invisible. Those sites are
  counted and printed as ``unresolved`` so the blind spot has a number.
* **Class names are matched by bare name, not by import.** Two classes sharing a name
  in different modules are treated as one; if either descends from
  ``VersionedModel`` both are. That errs toward flagging.
* **Scope-level, not data-flow.** Any ``server_version`` set anywhere in the
  enclosing function satisfies every ``bulk_create`` in it, including one for a
  different model or on a different branch. The check proves the author thought about
  the counter, not that every row got it.
* **Indirect inserts.** A list built in another function and handed in, or a helper
  wrapping ``bulk_create`` (``bulk_create_tasks``), is judged at the one
  ``bulk_create`` inside the helper -- callers of the helper are not examined. The
  helper is expected to set the counter itself (it does).
* **``simple_history`` ``bulk_create_with_history`` and ``bulk_update``** are not
  ``bulk_create`` calls and are not examined.
* ``# safe-bulk-create:`` is a rubber stamp, like ``# safe-constraint:``. It removes
  the silence, not the possibility of a wrong answer.

Usage:
    python3 scripts/check-bulk-create-server-version.py [--list] [--root DIR]
    python3 scripts/check-bulk-create-server-version.py --self-test
"""

from __future__ import annotations

import ast
import contextlib
import io
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SRC_REL = "packages/api/src"
_MARKER = "# safe-bulk-create:"
_ROOT_MODEL = "VersionedModel"
_MANAGERS = {"objects", "_default_manager"}


def _base_names(node: ast.ClassDef) -> list[str]:
    names: list[str] = []
    for base in node.bases:
        if isinstance(base, ast.Name):
            names.append(base.id)
        elif isinstance(base, ast.Attribute):
            names.append(base.attr)
    return names


def _source_files(src: Path) -> list[Path]:
    return sorted(p for p in src.rglob("*.py") if "migrations" not in p.parts)


def _versioned_classes(trees: dict[Path, ast.Module]) -> tuple[set[str], set[str]]:
    """Return (descendants of ``VersionedModel`` by bare name, every class name)."""
    bases: dict[str, set[str]] = {}
    for tree in trees.values():
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                bases.setdefault(node.name, set()).update(_base_names(node))
    versioned = {_ROOT_MODEL}
    changed = True
    while changed:
        changed = False
        for name, parents in bases.items():
            if name not in versioned and parents & versioned:
                versioned.add(name)
                changed = True
    return versioned - {_ROOT_MODEL}, set(bases)


def _receiver(call: ast.Call) -> tuple[bool, str | None]:
    """Is this a ``X.<manager>.bulk_create(...)`` call, and what is ``X``?

    Returns ``(is_bulk_create, model_name)``. ``model_name`` is ``None`` when the
    receiver is not a bare class name (the "unresolved" blind spot).
    """
    func = call.func
    if not (isinstance(func, ast.Attribute) and func.attr == "bulk_create"):
        return False, None
    manager = func.value
    if (
        isinstance(manager, ast.Attribute)
        and manager.attr in _MANAGERS
        and isinstance(manager.value, ast.Name)
    ):
        return True, manager.value.id
    return True, None


def _sets_server_version(scope: ast.AST) -> bool:
    for node in ast.walk(scope):
        if isinstance(node, ast.keyword) and node.arg == "server_version":
            return True
        if (
            isinstance(node, ast.Attribute)
            and node.attr == "server_version"
            and isinstance(node.ctx, ast.Store)
        ):
            return True
    return False


def _has_marker(lines: list[str], call: ast.Call) -> bool:
    """Is ``# safe-bulk-create:`` inside the call, or in the comment block above it?"""
    end = call.end_lineno or call.lineno
    for i in range(call.lineno - 1, min(end, len(lines))):
        if _MARKER in lines[i]:
            return True
    i = call.lineno - 2
    while i >= 0:
        stripped = lines[i].strip()
        if not stripped:
            i -= 1
            continue
        if not stripped.startswith("#"):
            break
        if _MARKER in stripped:
            return True
        i -= 1
    return False


class _Scan(NamedTuple):
    violations: list[str]
    safe: list[str]
    unresolved: list[str]


def _scan_file(
    path: Path, tree: ast.Module, versioned: set[str], known: set[str], root: Path
) -> _Scan:
    lines = path.read_text(encoding="utf-8").splitlines()
    rel = str(path.relative_to(root))
    result = _Scan([], [], [])

    def visit(node: ast.AST, scope: ast.AST) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            scope = node
        if isinstance(node, ast.Call):
            is_bulk, model = _receiver(node)
            # A lower-case variable (`model.objects`) is not a class name we parsed;
            # it is the blind spot, not a clean site.
            if is_bulk and model not in known:
                result.unresolved.append(f"{rel}:{node.lineno}")
            elif is_bulk and model in versioned:
                where = f"{rel}:{node.lineno} ({model})"
                if _sets_server_version(scope):
                    result.safe.append(f"{where}: server_version set in scope")
                elif _has_marker(lines, node):
                    result.safe.append(f"{where}: {_MARKER} asserted")
                else:
                    result.violations.append(where)  # GATE-ARMED
        for child in ast.iter_child_nodes(node):
            visit(child, scope)

    visit(tree, tree)
    return result


def _scan_tree(root: Path) -> _Scan | None:
    src = root / _SRC_REL
    if not src.exists():
        return None
    trees: dict[Path, ast.Module] = {}
    for path in _source_files(src):
        try:
            trees[path] = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover - a broken file fails elsewhere
            continue
    versioned, known = _versioned_classes(trees)
    total = _Scan([], [], [])
    for path, tree in trees.items():
        part = _scan_file(path, tree, versioned, known, root)
        total.violations.extend(part.violations)
        total.safe.extend(part.safe)
        total.unresolved.extend(part.unresolved)
    return total


class _Case(NamedTuple):
    name: str
    expect: int
    body: str  # the module that holds the bulk_create
    mentions: tuple[str, ...] = ()


_MODELS = (
    "class VersionedModel:\n    pass\n\n\n"
    "class Thing(VersionedModel):\n    pass\n\n\n"
    "class SubThing(Thing):\n    pass\n\n\n"
    "class Plain:\n    pass\n"
)


def _self_test_cases() -> list[_Case]:
    """One fixture per branch of the rule; both directions are covered.

    A gate only ever watched passing on a clean tree is indistinguishable from one
    with a typo in its pattern, and a gate that rejects the correct shapes gets
    papered over with blanket opt-outs within a day.
    """
    return [
        _Case(
            "a bulk_create of a VersionedModel with no server_version",
            1,
            "def go():\n    Thing.objects.bulk_create([Thing(name='a')])\n",
            ("mod.py", "(Thing)"),
        ),
        _Case(
            "a bulk_create through _default_manager",
            1,
            "def go():\n    Thing._default_manager.bulk_create([Thing()])\n",
            ("(Thing)",),
        ),
        _Case(
            "a transitive subclass of VersionedModel",
            1,
            "def go():\n    SubThing.objects.bulk_create([SubThing()])\n",
            ("(SubThing)",),
        ),
        _Case(
            "a sync_seq-only fix (the exact shape that hid this class)",
            1,
            "def go(seq):\n"
            "    rows = [Thing()]\n"
            "    for r in rows:\n"
            "        r.sync_seq = seq\n"
            "    Thing.objects.bulk_create(rows)\n",
        ),
        _Case(
            "server_version= on the constructor",
            0,
            "def go():\n    Thing.objects.bulk_create([Thing(server_version=1)])\n",
        ),
        _Case(
            "an assignment loop over the objects",
            0,
            "def go():\n"
            "    rows = [Thing()]\n"
            "    for r in rows:\n"
            "        r.server_version = 1\n"
            "    Thing.objects.bulk_create(rows)\n",
        ),
        _Case(
            "a model that is not a VersionedModel",
            0,
            "def go():\n    Plain.objects.bulk_create([Plain()])\n",
        ),
        _Case(
            "an unresolvable receiver is counted, not failed",
            0,
            "def go(model):\n    model.objects.bulk_create([])\n",
        ),
        _Case(
            "a # safe-bulk-create: opt-out above the call",
            0,
            "def go():\n"
            "    # safe-bulk-create: rows are read back and re-saved by the caller.\n"
            "    Thing.objects.bulk_create([Thing()])\n",
        ),
        _Case(
            "a comment missing the marker's colon form",
            1,
            "def go():\n"
            "    # safe bulk create, honest\n"
            "    Thing.objects.bulk_create([Thing()])\n",
        ),
        _Case(
            "server_version set in a DIFFERENT function does not count",
            1,
            "def other():\n    return Thing(server_version=1)\n\n\n"
            "def go():\n    Thing.objects.bulk_create([Thing()])\n",
        ),
    ]


def _run_case(case: _Case, tree: Path) -> str | None:
    global _REPO_ROOT
    for name, source in (("models.py", _MODELS), ("mod.py", case.body)):
        try:
            ast.parse(source)
        except SyntaxError as exc:
            # A typo'd fixture would make every REJECT case pass for free.
            return f"{case.name}: fixture {name} is not valid Python ({exc})"
    pkg = tree / _SRC_REL / "trueppm_api/apps/x"
    pkg.mkdir(parents=True)
    (pkg / "models.py").write_text(_MODELS, encoding="utf-8")
    (pkg / "mod.py").write_text(case.body, encoding="utf-8")

    saved = _REPO_ROOT
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            code = main(["--root", str(tree)])
    finally:
        _REPO_ROOT = saved
    if code != case.expect:
        got = "accepted" if code == 0 else "rejected"
        return f"{case.name}: gate {got} it (exit {code}), expected exit {case.expect}"
    for needle in case.mentions:
        if needle not in captured.getvalue():
            return f"{case.name}: rejection never names {needle!r}"
    return None


def _self_test() -> int:
    cases = _self_test_cases()
    failures: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        for index, case in enumerate(cases):
            failure = _run_case(case, Path(tmp) / f"case{index:02d}")
            if failure is None:
                verdict = "accepted" if case.expect == 0 else "rejected"
                print(f"SELF-TEST OK: {case.name} -- correctly {verdict}.")
            else:
                failures.append(failure)
                print(f"SELF-TEST FAIL: {failure}")
    if failures:
        sys.stdout.flush()
        print(
            f"\nSELF-TEST: {len(failures)} of {len(cases)} cases failed -- this gate "
            "is not detecting what it claims to.",
            file=sys.stderr,
        )
        return 1
    print(f"\nSELF-TEST: all {len(cases)} cases passed.")
    return 0


def main(argv: list[str]) -> int:
    global _REPO_ROOT
    if "--self-test" in argv:
        return _self_test()
    if "--root" in argv:
        _REPO_ROOT = Path(argv[argv.index("--root") + 1]).resolve()
    scan = _scan_tree(_REPO_ROOT)
    if scan is None:
        print(f"-> bulk-create-server-version: {_REPO_ROOT / _SRC_REL} not found.")
        return 1

    if "--list" in argv:
        for line in scan.safe:
            print(f"  safe   {line}")
        for line in scan.unresolved:
            print(f"  blind  {line}")

    if not scan.violations:
        print(
            f"OK: every VersionedModel bulk_create sets server_version "
            f"({len(scan.safe)} checked, {len(scan.unresolved)} unresolved receivers "
            "not examined)."
        )
        return 0

    print("FAIL: bulk_create of a VersionedModel that leaves server_version = 0:\n")
    for line in scan.violations:
        print(f"  {line}")
    print(
        "\nbulk_create never calls save(), so the INSERT path that sets"
        "\nserver_version = 1 does not run. The row publishes server_version = 0 -- a"
        "\ntoken no client can echo back as X-Base-Version.\n"
        "\nSet it on the constructor:\n"
        "\n    Thing(..., server_version=1)\n"
        "\nor, if the rows are deliberately written another way, say why:\n"
        f"\n    {_MARKER} <reason>\n"
        "    Thing.objects.bulk_create(...)\n"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
