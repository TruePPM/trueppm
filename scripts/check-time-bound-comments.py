#!/usr/bin/env python3
"""Fail on a time-bound phrase in a source comment with no tracker anchor (#4399).

Five comments asserted facts a later change made false ("Stub -- used by a future
viewset", "As of this writing 0009 is UNRELEASED", "O(span) day loop"). Nothing
re-checks a comment whose claim is about *time*, so the claim outlives the fact.

RULE: under ``packages/*/src``, a line matching one of the phrases below fails unless
that line or one of the two lines above carries ``TODO(#NNN)`` (policed by
``lint:todo-grep``) or ``# time-bound-ok: <reason>`` (``//`` form accepted).

Phrases: ``UNRELEASED`` (uppercase), ``Stub --`` (em dash or ``--``), ``future ... viewset``,
``as of this writing`` (case-insensitive except UNRELEASED).

What this cannot do: an opt-out is a rubber stamp -- it removes the SILENCE, not the
possibility of a wrong answer. It is a phrase grep, so a stale claim worded any other
way ("not yet released", "O(span)") is invisible to it.

Usage:
  check-time-bound-comments.py [ROOT_GLOB_DIR...]   # default: packages/*/src
  check-time-bound-comments.py --self-test
Exit: 0 clean · 1 violation · 2 invocation error
"""

from __future__ import annotations

import re
import sys
import tempfile
from pathlib import Path

EXTS = {".py", ".ts", ".tsx", ".js", ".rs"}
SKIP_DIRS = {"node_modules", "dist", "build", "__pycache__", ".venv", "target"}
PHRASES = [
    re.compile(r"UNRELEASED"),
    re.compile(r"Stub\s*(?:—|--)"),
    re.compile(r"\bfuture\b[^\n]{0,40}\bviewset", re.I),
    re.compile(r"as of this writing", re.I),
]
ANCHOR = re.compile(r"TODO\(#\d+\)|time-bound-ok:\s*\S")
LOOKBACK = 2


def scan_text(text: str) -> list[tuple[int, str]]:
    lines = text.splitlines()
    hits = []
    for i, line in enumerate(lines):
        if not any(p.search(line) for p in PHRASES):
            continue
        window = lines[max(0, i - LOOKBACK) : i + 1]
        if any(ANCHOR.search(w) for w in window):
            continue
        hits.append((i + 1, line.strip()))
    return hits


def scan_dirs(dirs: list[Path]) -> int:
    bad = 0
    for d in dirs:
        for p in sorted(d.rglob("*")):
            if not p.is_file() or p.suffix not in EXTS:
                continue
            if SKIP_DIRS & set(p.parts):
                continue
            try:
                text = p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for n, line in scan_text(text):
                print(
                    f"{p}:{n}: time-bound phrase without TODO(#NNN) or time-bound-ok: {line}"
                )
                bad += 1
    if bad:
        print(
            f"\n{bad} time-bound comment(s). Anchor each with TODO(#NNN) (open issue) or "
            "`# time-bound-ok: <reason>`, or reword so the claim cannot go stale (#4399).",
            file=sys.stderr,
        )
    return 1 if bad else 0


def self_test() -> int:
    bad_text = "# As of this writing 0009 is UNRELEASED, so it is not elidable.\n"
    ok_cases = {
        "anchored todo": "# TODO(#12): UNRELEASED until the tag\n",
        "opt out above": "# time-bound-ok: names the live release gate\n# UNRELEASED\n",
        "plain text": "# unreleased kombu fixes; nothing time-bound here\nx = 1\n",
    }
    with tempfile.TemporaryDirectory() as td:
        t = Path(td) / "src"
        t.mkdir()
        (t / "bad.py").write_text(bad_text)
        if scan_dirs([t]) != 1:
            print(
                "self-test FAILED: reintroduced 'As of this writing ... UNRELEASED' not caught"
            )
            return 1
        (t / "bad.py").unlink()
        for name, text in ok_cases.items():
            (t / "ok.py").write_text(text)
            if scan_dirs([t]) != 0:
                print(f"self-test FAILED: false positive on {name}")
                return 1
        (t / "ok.py").write_text('"""Stub — used by a future viewset."""\n')
        if scan_dirs([t]) != 1:
            print("self-test FAILED: 'Stub -- future viewset' not caught")
            return 1
    print("self-test ok")
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["--self-test"]:
        return self_test()
    dirs = [Path(a) for a in argv] or sorted(Path(".").glob("packages/*/src"))
    if not dirs or not all(d.is_dir() for d in dirs):
        print("no scan roots found", file=sys.stderr)
        return 2
    return scan_dirs(dirs)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
