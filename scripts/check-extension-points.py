#!/usr/bin/env python3
"""Every OSS extension point is accounted for (#3199).

``boundary:imports`` proves the one-way dependency: OSS never imports
``trueppm_enterprise``. Nothing proved the other direction, that somebody owns
the far side of a seam. Three ENFORCE seams shipped with docstrings promising
Enterprise behavior that no Enterprise code provided, and both repositories
stayed green.

A seam is found structurally, never from a hand-maintained list:

* a module-level public ``def register_*``;
* a module-level provider slot (``_..._PROVIDER`` / ``_..._provider``);
* a module-level ``*_CONTRACT_VERSION`` constant, the handle for a write-side
  seam where Enterprise calls OSS and registers nothing (#3780).

Each must be accounted for, not necessarily consumed: its module docstring names
``EE#NNN``, ``trueppm-enterprise#NNN`` or ``ADR-NNNN``, or carries
``unconsumed: <reason>``; or the comment block directly above the seam carries
``# unconsumed: <reason>``.

Second rule (#3866): a provider slot is never called directly. A slot is a name
a ``register_*`` function rebinds with ``global`` or appends to; calling it, a
local alias of it, or a loop variable over it fails unless a ``# FAIL-CLOSED``
comment is on the calling statement itself or in the comment block directly above
it. The marker means only "this bare veto call is deliberate"; do not use it to
describe a contained call's fallback. Use ``invoke_extension_provider()``. A slot
handed to another function and called there is not followed.

Blind spot: registries that are not a rebound or appended module name are not
seen at all, so OSS invokes their callables bare and this gate stays green. That
covers ``ProviderRegistry`` instances (``TASK_LINK_PROVIDERS``,
``OUTGOING_CHANNEL_PROVIDERS``, ``NOTIFICATION_CHANNELS``,
``EXTERNAL_TASK_SOURCES``) and dict-keyed ones
(``schema_migrations._MIGRATIONS``). Containing those is tracked in #5157.

What this cannot do: it does not query the Enterprise tracker (a gate that needs
a second repository over the network fails on weather), so a reference to a
closed or wrong issue passes, and so does any ADR number. A module docstring
accounts for every seam in that module. It removes the silence, not the wrong
answer.

Usage:
    check-extension-points.py [ROOT]    # default: packages/api/src
    check-extension-points.py --list [ROOT]
    check-extension-points.py --self-test

Exit codes: 0 clean, 1 findings, 2 invocation error (including no seam found).
"""

from __future__ import annotations

import ast
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = REPO / "packages" / "api" / "src"

_REFERENCE = re.compile(
    r"\bEE#\d+|\btrueppm-enterprise#\d+|\bADR-\d{3,}|\bunconsumed:[ \t]*\S"
)
_COMMENT_MARKER = re.compile(r"#.*\bunconsumed:[ \t]*\S")
_SLOT_NAME = re.compile(r"^_\w*(PROVIDER|provider)$")


def _targets(node: ast.stmt) -> list[str]:
    if isinstance(node, ast.Assign):
        return [t.id for t in node.targets if isinstance(t, ast.Name)]
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return [node.target.id]
    return []


def seams(tree: ast.Module) -> list[tuple[str, int]]:
    """``(name, first line)`` of every extension point the module declares."""
    found: list[tuple[str, int]] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name.startswith("register_"):
                first = min([node.lineno, *(d.lineno for d in node.decorator_list)])
                found.append((node.name, first))
            continue
        for name in _targets(node):
            if _SLOT_NAME.match(name) or name.endswith("_CONTRACT_VERSION"):
                found.append((name, node.lineno))
    return found


def provider_slots(tree: ast.Module) -> set[str]:
    """Names a ``register_*`` function stores a caller-supplied provider in."""
    slots: set[str] = set()
    for node in tree.body:
        if not (
            isinstance(node, ast.FunctionDef) and node.name.startswith("register_")
        ):
            continue
        for child in ast.walk(node):
            if isinstance(child, ast.Global):
                slots.update(child.names)
            elif (
                isinstance(child, ast.Call)
                and isinstance(child.func, ast.Attribute)
                and child.func.attr == "append"
                and isinstance(child.func.value, ast.Name)
            ):
                slots.add(child.func.value.id)
    return slots


def bare_calls(tree: ast.Module, slots: set[str]) -> list[tuple[str, ast.Call]]:
    """``(slot, call)`` of every direct call of a slot, its alias or its items."""
    found: dict[tuple[str, int], ast.Call] = {}
    functions = [
        n
        for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    for scope in functions:
        names = {slot: slot for slot in slots}
        nodes = list(ast.walk(scope))
        for node in nodes:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Name):
                if node.value.id in slots:
                    names.update({name: node.value.id for name in _targets(node)})
            elif isinstance(node, (ast.For, ast.comprehension)):
                if (
                    isinstance(node.iter, ast.Name)
                    and node.iter.id in slots
                    and isinstance(node.target, ast.Name)
                ):
                    names[node.target.id] = node.iter.id
        for node in nodes:
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                if node.func.id in names:
                    found[(names[node.func.id], node.lineno)] = node
    return [
        (slot, call)
        for (slot, _), call in sorted(found.items(), key=lambda item: item[0][1])
    ]


def _fail_closed(lines: list[str], statement: ast.stmt | None, call: ast.Call) -> bool:
    """Whether ``# FAIL-CLOSED`` is on the calling statement or directly above it.

    A compound statement (``if``, ``for``) is read only up to the call, so a marker
    somewhere in its body cannot exempt a call in its header.
    """
    node: ast.stmt | ast.Call = statement or call
    last = call.end_lineno if hasattr(node, "body") else node.end_lineno
    if any("# FAIL-CLOSED" in text for text in lines[node.lineno - 1 : last]):
        return True
    index = node.lineno - 2
    while index >= 0 and lines[index].lstrip().startswith("#"):
        if "# FAIL-CLOSED" in lines[index]:
            return True
        index -= 1
    return False


def _marked_above(lines: list[str], first_line: int) -> bool:
    index = first_line - 2
    while index >= 0 and lines[index].lstrip().startswith("#"):
        if _COMMENT_MARKER.search(lines[index]):
            return True
        index -= 1
    return False


def scan(root: Path) -> tuple[list[str], list[str], list[str]]:
    """Return ``(seams, unaccounted seams, bare calls)`` as ``path:line name`` strings."""
    every: list[str] = []
    bad: list[str] = []
    bare: list[str] = []
    for path in sorted(root.rglob("*.py")):
        if "migrations" in path.parts:
            continue
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        lines = source.splitlines()
        # ast.walk is breadth-first, so the innermost statement is assigned last.
        statements = {
            child: node
            for node in ast.walk(tree)
            if isinstance(node, ast.stmt)
            for child in ast.walk(node)
            if isinstance(child, ast.Call)
        }
        for slot, call in bare_calls(tree, provider_slots(tree)):
            if not _fail_closed(lines, statements.get(call), call):
                bare.append(f"{path.relative_to(root)}:{call.lineno} {slot}")
        declared = seams(tree)
        if not declared:
            continue
        accounted = bool(_REFERENCE.search(ast.get_docstring(tree) or ""))
        for name, line in declared:
            label = f"{path.relative_to(root)}:{line} {name}"
            every.append(label)
            if not accounted and not _marked_above(lines, line):
                bad.append(label)
    return every, bad, bare


# --- self-test --------------------------------------------------------------

_REGISTER = "def register_thing(provider):\n    pass\n"
_SLOT = (
    '''"""ADR-0029."""\n_X_PROVIDER = None\n'''
    "def register_x(p):\n    global _X_PROVIDER\n    _X_PROVIDER = p\n"
)
_LIST = '''"""ADR-0029."""\n_ITEMS = []\ndef register_x(p):\n    _ITEMS.append(p)\n'''
_CASES: list[tuple[str, int, str]] = [
    ("planted unaccounted register seam", 1, '"""Does a thing."""\n' + _REGISTER),
    ("planted unaccounted provider slot", 1, "_THING_PROVIDER = None\n"),
    ("planted unaccounted write-side seam", 1, '"""Push."""\nX_CONTRACT_VERSION = 1\n'),
    (
        "a bare ENTERPRISE mention is not a reference",
        1,
        '"""trueppm-enterprise."""\n' + _REGISTER,
    ),
    ("an empty unconsumed marker is not a reason", 1, "# unconsumed:\n" + _REGISTER),
    ("EE reference in docstring", 0, '"""Consumer: EE#1."""\n' + _REGISTER),
    (
        "long-form reference",
        0,
        '"""trueppm-enterprise#200."""\nX_CONTRACT_VERSION = 1\n',
    ),
    ("ADR reference", 0, '"""ADR-0029."""\n' + _REGISTER),
    ("unconsumed in docstring", 0, '"""\nunconsumed: nobody yet\n"""\n' + _REGISTER),
    (
        "unconsumed comment above the seam",
        0,
        "# unconsumed: spare\n# more\n" + _REGISTER,
    ),
    ("bare slot call", 1, _SLOT + "def use():\n    return _X_PROVIDER()\n"),
    (
        "bare call of a local alias",
        1,
        _SLOT + "def use():\n    p = _X_PROVIDER\n    return p()\n",
    ),
    (
        "bare call of a registry item",
        1,
        _LIST + "def use():\n    for r in _ITEMS:\n        r()\n",
    ),
    ("contained slot call", 0, _SLOT + "def use():\n    return invoke(_X_PROVIDER)\n"),
    (
        "FAIL-CLOSED bare call",
        0,
        _SLOT + "def use():\n    # FAIL-CLOSED: veto\n    return _X_PROVIDER()\n",
    ),
    (
        "FAIL-CLOSED on the calling statement",
        0,
        _SLOT + "def use():\n    return _X_PROVIDER()  # FAIL-CLOSED: veto\n",
    ),
    (
        "a marker above a contained call does not cover a bare call below",
        1,
        _SLOT
        + "def use():\n    # FAIL-CLOSED: veto\n    a = invoke(_X_PROVIDER)\n"
        + "    b = a\n    return _X_PROVIDER()\n",
    ),
    (
        "a marker in an if body does not cover its condition",
        1,
        _SLOT
        + "def use():\n    if _X_PROVIDER():\n"
        + "        # FAIL-CLOSED: veto\n        return 1\n",
    ),
    ("a tree with no seam is an error, not a pass", 2, "x = 1\n"),
]


def self_test() -> int:
    """Run the real script against planted fixtures and assert exact exit codes."""
    failed = 0
    for name, want, source in _CASES:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "mod.py").write_text(source, encoding="utf-8")
            got = subprocess.run(
                [sys.executable, __file__, tmp], capture_output=True, check=False
            ).returncode
        if got != want:
            failed += 1
        print(f"{'ok  ' if got == want else 'FAIL'} {name} (want {want}, got {got})")
    return 1 if failed else 0


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        return self_test()
    listing = argv[:1] == ["--list"]
    rest = argv[1:] if listing else argv
    root = Path(rest[0]) if rest else DEFAULT_ROOT
    if len(rest) > 1 or not root.is_dir():
        print(
            "usage: check-extension-points.py [--list] [ROOT] | --self-test",
            file=sys.stderr,
        )
        return 2
    every, bad, bare = scan(root)
    if not every:
        print(
            f"no extension point found under {root}; the scan is broken",
            file=sys.stderr,
        )
        return 2
    if listing:
        print("\n".join(every))
        return 0
    if bad:
        print("Unaccounted extension point(s):")
        for label in bad:
            print(f"  {label}")
        print(
            "\nName who owns the other side in the module docstring (EE#NNN, "
            "trueppm-enterprise#NNN or ADR-NNNN), or write `# unconsumed: <reason>` "
            "above the seam."
        )
    if bare:
        print("Extension provider(s) called directly; use invoke_extension_provider():")
        for label in bare:
            print(f"  {label}")
    if bad or bare:
        return 1
    print(
        f"OK: {len(every)} extension point(s), all accounted for and none called bare."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
