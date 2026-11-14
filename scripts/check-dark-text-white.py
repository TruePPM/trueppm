#!/usr/bin/env python3
"""Gate: a filled semantic/brand surface may not pair `text-white` with no dark override.

WHY THIS EXISTS (#4669)
In dark mode the semantic and brand fills flip to LIGHT tones (critical #F87171,
brand #66B998, at-risk #FB923C, warning #FACC15), so white text on them measures
2.3-2.8:1, below the 4.5:1 WCAG 1.4.3 floor. The shared `Button` handles it with
`text-white dark:text-navy-900`; ~30 hand-rolled buttons never did, and the same
shape (`bg-brand-primary text-white`) had already been swept once (#2041) and
recurred because nothing enforced it.

WHAT IS CHECKED
Every string/template literal under packages/web/src (non-test) is one class
list. A literal that holds a BASE-STATE (no variant prefix) `bg-semantic-*` or
`bg-brand-*` fill and a BASE-STATE `text-white` must also hold a `dark:text-*`
class. A `-bg` pale fill (`bg-semantic-critical-bg`) or an opacity fill
(`bg-brand-primary/10`) is not a solid fill and is ignored. The unit is the
literal, not the line, so a class list wrapped over several lines is covered;
a fill and its text split across two literals of one expression is not (a known
blind spot, reported by --self-test).

  --self-test   prove the scanner flags the bad shape and passes the fixed one.
  --list        print violations without failing (for triage).
Opt a deliberate site out with `dark-text-ok: <reason>` anywhere in the literal's
enclosing 3 lines above.
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "packages" / "web" / "src"

FILL = re.compile(
    r"(?<![\w:/-])bg-(?:semantic|brand)-[a-z]+(?:-[a-z]+)*(?![\w/-])|(?<![\w:/-])bg-(?:semantic|brand)-[a-z]+-(?:dark|light)(?![\w/])"
)
WHITE = re.compile(r"(?<![\w:/-])text-white(?![\w-])")
DARK_TEXT = re.compile(r"(?<![\w-])dark:text-")


def is_solid_fill(token: str) -> bool:
    return not token.endswith("-bg")


QUOTES = "\"'`"


def _literal_around(text: str, pos: int) -> tuple[int, int]:
    """Bounds of the class list holding `pos`: the nearest quote char either side.

    Class tokens never contain a quote, so this finds the enclosing literal
    without parsing the file — a paired-quote regex desyncs on the first
    apostrophe in a comment or JSX text and then misses every literal after it.
    """
    left = max(text.rfind(q, 0, pos) for q in QUOTES)
    rights = [i for i in (text.find(q, pos) for q in QUOTES) if i != -1]
    right = min(rights) if rights else len(text)
    return left + 1, right


def violations_in(text: str) -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    seen: set[int] = set()
    for m in WHITE.finditer(text):
        lo, hi = _literal_around(text, m.start())
        if lo in seen:
            continue
        seen.add(lo)
        body = text[lo:hi]
        fills = [f for f in FILL.findall(body) if is_solid_fill(f)]
        if not fills or DARK_TEXT.search(body):
            continue
        line = text.count("\n", 0, m.start()) + 1
        above = "\n".join(text.splitlines()[max(0, line - 4) : line])
        if "dark-text-ok:" in above:
            continue
        found.append((line, fills[0]))
    return found


def scan() -> list[tuple[pathlib.Path, int, str]]:
    out = []
    for path in sorted(SRC.rglob("*.ts*")):
        name = path.name
        if ".test." in name or name.endswith(".d.ts") or "/test/" in str(path):
            continue
        for line, fill in violations_in(path.read_text(encoding="utf-8")):
            out.append((path.relative_to(ROOT), line, fill))
    return out


def self_test() -> int:
    bad = [
        '<b className="px-3 bg-semantic-critical text-white font-medium" />',
        "const c = `rounded\n  bg-brand-primary\n  hover:bg-brand-primary-dark text-white`;",
    ]
    good = [
        '<b className="bg-semantic-critical text-white dark:text-navy-900" />',
        '<b className="bg-semantic-critical-bg text-white" />',
        '<b className="bg-brand-primary/10 text-white" />',
        '<b className="hover:bg-brand-primary text-neutral-text-primary" />',
        '<b className="dark:bg-brand-primary text-white" />',
    ]
    failures = [t for t in bad if not violations_in(t)] + [
        t for t in good if violations_in(t)
    ]
    for t in failures:
        print(f"SELF-TEST FAIL: {t!r}", file=sys.stderr)
    if not failures:
        print(
            "self-test OK (known blind spot: fill and text-white in two literals of one expression)"
        )
    return 1 if failures else 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    hits = scan()
    for path, line, fill in hits:
        print(f"{path}:{line}: `{fill}` + `text-white` with no `dark:text-*` override")
    if hits and "--list" not in sys.argv:
        print(
            f"\nFAIL: {len(hits)} filled semantic/brand surface(s) pair text-white with no dark override "
            "(white on the dark-mode light fills is 2.3-2.8:1). Add `dark:text-navy-900` (as Button does), "
            'or use <Button variant="danger">. See web-rule 456.',
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
