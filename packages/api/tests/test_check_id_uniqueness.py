"""Every ``trueppm.*`` deploy-check id names exactly one check (#3221).

Check ids are an operator-facing contract: they go into ``SILENCED_SYSTEM_CHECKS``.
Two unrelated checks sharing an id means silencing one silences the other.
"""

from __future__ import annotations

import ast
import re
from collections import defaultdict
from pathlib import Path

import trueppm_api

_SRC = Path(trueppm_api.__file__).parent
_ID_PREFIX = "trueppm."


def _is_id(value: object) -> bool:
    # Only Django system-check ids (E/W/I + digits); other ``trueppm.*`` strings
    # are metric and span names.
    return isinstance(value, str) and re.fullmatch(r"trueppm\.[EWI]\d{3}", value) is not None


def _collect_ids(source: str) -> dict[str, set[str]]:
    """Map each ``trueppm.*`` id literal to the top-level functions that use it.

    Module-level string constants holding an id are resolved, so
    ``id=_ID_FOO`` is attributed to the function using it, not to the constant.
    A literal outside any function is attributed to ``<module>``.
    """
    tree = ast.parse(source)
    constants = {
        target.id: node.value.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and isinstance(node.value, ast.Constant)
        and _is_id(node.value.value)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    users: dict[str, set[str]] = defaultdict(set)
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            continue  # the constant definition itself
        owner = node.name if isinstance(node, ast.FunctionDef) else "<module>"
        for sub in ast.walk(node):
            if isinstance(sub, ast.Constant) and _is_id(sub.value):
                users[sub.value].add(owner)
            elif isinstance(sub, ast.Name) and sub.id in constants:
                users[constants[sub.id]].add(owner)
    return users


def _all_ids() -> dict[str, set[str]]:
    merged: dict[str, set[str]] = defaultdict(set)
    for path in sorted((_SRC).rglob("*.py")):
        if _ID_PREFIX not in (text := path.read_text()):
            continue
        for check_id, owners in _collect_ids(text).items():
            merged[check_id] |= {f"{path.name}:{o}" for o in owners}
    return merged


def test_no_two_checks_share_an_id() -> None:
    collisions = {
        check_id: {o.split(":", 1)[1] for o in owners}
        for check_id, owners in _all_ids().items()
        if len({o.split(":", 1)[1] for o in owners}) > 1
    }
    assert not collisions, (
        "Two distinct checks share a trueppm.* id. Give the newer one a fresh id "
        f"(next free E0NN). Collisions found: {collisions}"
    )


def test_collector_detects_a_collision() -> None:
    """Negative control: the collector reports a shared id, via literal or constant."""
    source = (
        '_ID = "trueppm.E900"\n'
        "def a():\n    return Error(id=_ID)\n"
        "def b():\n    return Error(id='trueppm.E900')\n"
    )
    assert _collect_ids(source)["trueppm.E900"] == {"a", "b"}
