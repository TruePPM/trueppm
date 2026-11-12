#!/usr/bin/env python3
"""Fail when a loading skeleton puts aria-label on a role-less element (#4618).

aria-label is prohibited on a generic div/span/section: a screen reader gets no
name and no loading announcement. A loading placeholder must carry
role="status" (or use the shared LoadingSkeleton, which does).

Usage: scripts/check-loading-skeleton-role.py [--self-test]
Opt out a deliberate site with `skeleton-role-ok` inside the opening tag's
preceding line comment.
"""

import pathlib
import re
import sys

TAG = re.compile(
    r"<(div|section|ul|span|p)\b((?:[^<>{}]|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*?)>", re.S
)
LOADING = re.compile(r"aria-label=(\{[^}]*Loading|\"Loading|'Loading)")


def scan(text: str) -> list[int]:
    hits = []
    for m in TAG.finditer(text):
        attrs = m.group(2)
        if LOADING.search(attrs) and "role=" not in attrs:
            line = text.count("\n", 0, m.start()) + 1
            prev = text.splitlines()[line - 2] if line > 1 else ""
            if "skeleton-role-ok" not in prev:
                hits.append(line)
    return hits


def self_test() -> int:
    bad = '<div aria-label="Loading things…" className="x" />'
    bad_tpl = "<div\n  aria-busy\n  aria-label={`Loading ${x}`}\n>"
    good = '<div role="status" aria-label="Loading things…" />'
    other = '<div aria-label="Close" />'
    ok = (
        scan(bad) == [1]
        and scan(bad_tpl) == [1]
        and scan(good) == []
        and scan(other) == []
    )
    print("self-test " + ("ok" if ok else "FAILED"))
    return 0 if ok else 1


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    failures = []
    for p in sorted(pathlib.Path("packages/web/src").rglob("*.tsx")):
        if ".test." in p.name:
            continue
        for line in scan(p.read_text()):
            failures.append(f"{p}:{line}")
    if failures:
        print(
            'aria-label="Loading…" on an element with no role (#4618). Add role="status"'
        )
        print("or use components/LoadingSkeleton:")
        print("\n".join(failures))
        return 1
    print("ok: no role-less loading aria-label")
    return 0


if __name__ == "__main__":
    sys.exit(main())
