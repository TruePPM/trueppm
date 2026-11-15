"""A "removed in 0.X" promise in `packages/api/src` must name the issue that removes it (#4090).

Four removals were promised only in comments, so nothing scheduled them and a reader of
the OpenAPI schema could not see them. The cheapest durable fix is to require the
comment to carry a `TODO(#NNN)`: the existing `lint:todo-grep` job then checks that the
issue is still open. This test is the half that forces the `TODO` to exist.
"""

from __future__ import annotations

import re
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "src" / "trueppm_api"
# Forward-looking removal promises. The look-behinds skip past tense ("was removed in 0.4").
_PROMISE = re.compile(
    r"(?<!was )(?<!were )(?<!been )\b(?:removed|dropped)\s+(?:entirely\s+)?"
    r"(?:in\s+0\.\d+|next\s+release)|drop it after 0\.\d+",
    re.IGNORECASE,
)
_TODO = re.compile(r"TODO\(#\d+\)")
_WINDOW = 12


def _promises_without_todo(lines: list[str]) -> list[int]:
    bad = []
    for i, line in enumerate(lines):
        if not _PROMISE.search(line):
            continue
        near = "\n".join(lines[max(0, i - _WINDOW) : i + _WINDOW + 1])
        if not _TODO.search(near):
            bad.append(i + 1)
    return bad


def test_removal_promise_detector_flags_a_bare_comment() -> None:
    assert _promises_without_todo(["# this alias is removed in 0.5"]) == [1]
    assert _promises_without_todo(["# removed in 0.5", "# TODO(#" + "12)"]) == []
    assert _promises_without_todo(["# was removed in 0.4 and is gone"]) == []


def test_every_removal_promise_carries_a_todo_issue() -> None:
    offenders = []
    for path in sorted(_SRC.rglob("*.py")):
        if "migrations" in path.parts:
            continue
        for lineno in _promises_without_todo(path.read_text().splitlines()):
            offenders.append(f"{path.relative_to(_SRC.parent.parent)}:{lineno}")
    assert not offenders, (
        "These comments promise a removal without a `TODO(#NNN)` naming the issue that "
        "schedules it (file one; lint:todo-grep then checks it stays open):\n  "
        + "\n  ".join(offenders)
    )
