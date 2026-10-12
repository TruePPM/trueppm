"""Grep-driven invariant: every hard-delete caller must opt into the broadcast (#4374).

``hard_delete_projects``/``hard_delete_program`` (``access/services.py``) used to
leave the ``project_hard_deleted`` sync broadcast entirely to the caller ("Callers
are responsible for ... sync broadcasts"). One of five callers —
``ProgramViewSet.remove_sample`` — silently didn't, and sent only the undeliverable
``program_deleted`` instead (#836, #4374). The fix moved the broadcast into the
helper behind a ``broadcast=True`` flag, but a hand-maintained list of "the current
callers" in a test would rot exactly the way the hand-written ``PROTECT`` list did
in #2364: a sixth caller added later, with the flag omitted, would pass silently
forever. This walks the actual source tree instead, so a new caller that forgets
``broadcast=True`` fails this test rather than shipping a sixth silent instance of
the same defect.
"""

from __future__ import annotations

import ast
from pathlib import Path

# packages/api/tests/apps/access/<this file> -> packages/api
API_ROOT = Path(__file__).resolve().parents[3]
SRC_ROOT = API_ROOT / "src" / "trueppm_api"

_TARGET_NAMES = {"hard_delete_projects", "hard_delete_program"}

# The helper's own module. hard_delete_program's internal call to
# hard_delete_projects forwards its own broadcast kwarg (`broadcast=broadcast`)
# rather than hardcoding True, which is correct, not an instance of the bug this
# test exists to catch.
_EXEMPT_PATH = SRC_ROOT / "apps" / "access" / "services.py"


def _call_name(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _has_broadcast_true(node: ast.Call) -> bool:
    return any(
        kw.arg == "broadcast" and isinstance(kw.value, ast.Constant) and kw.value.value is True
        for kw in node.keywords
    )


def _find_offending_calls() -> list[str]:
    offenders: list[str] = []
    found_any = False
    for path in SRC_ROOT.rglob("*.py"):
        if path == _EXEMPT_PATH:
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _call_name(node) in _TARGET_NAMES:
                found_any = True
                if not _has_broadcast_true(node):
                    offenders.append(f"{path.relative_to(SRC_ROOT)}:{node.lineno}")
    assert found_any, (
        "sanity check failed: found no call to hard_delete_projects()/"
        "hard_delete_program() outside access/services.py — this test's walk is "
        "broken, not proof the invariant holds"
    )
    return offenders


def test_every_hard_delete_caller_opts_into_broadcast() -> None:
    """A new caller must pass ``broadcast=True`` or this test names the call site."""
    offenders = _find_offending_calls()
    assert not offenders, (
        "every call to hard_delete_projects()/hard_delete_program() outside "
        "access/services.py must pass broadcast=True, so a project hard-deleted "
        "through it tells any open tab it is gone (#4374). Missing at: " + ", ".join(offenders)
    )
