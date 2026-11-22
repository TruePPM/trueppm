#!/usr/bin/env python3
"""Two greppable pairings that were found by hand and nothing checked (#4125).

1. ``aria-modal`` <-> focus trap. A web component that renders ``aria-modal``
   must call ``useFocusTrap`` (``hooks/useFocusTrap.ts``): ``aria-modal`` tells
   assistive tech the rest of the page is inert, so without a trap Tab walks
   out of the dialog into content the user was told does not exist (the #2193
   class). Opt out per file with ``focus-trap-ok: <reason>`` (required reason;
   e.g. a popover that deliberately does not trap).
2. "removed next release" prose <-> a machine-readable deprecation. A comment
   or message promising removal in the next release must sit beside an issue
   reference (``#NNNN``, within 3 lines) AND the file must carry a deprecation
   marker (``deprecated=True``, ``"deprecated": True``, ``deprecated: true``,
   ``@deprecated``, ``DeprecationWarning``), so a generated client or a grep
   can find the promise instead of it living only in a comment. Opt out per
   line with ``deprecation-ok: <reason>``.

Ratchet: ``scripts/pairings-baseline.txt`` lists today's unpaired files. It
can only shrink. A violation not in the baseline fails; a baseline entry that
is now paired also fails ("remove it"), so a fix is locked in and cannot be
reused by a later violation. ``--update-baseline`` only ever removes entries;
it refuses to add. Like every opt-out here, the baseline is a rubber stamp
that removes the silence, not a review of the grandfathered files.

Usage: check-pairings.py [--root DIR] [--baseline FILE] [--update-baseline]
       check-pairings.py --self-test
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parent.parent
BASELINE_REL = "scripts/pairings-baseline.txt"

WEB_SRC = "packages/web/src"
DEPRECATION_ROOTS = ("packages/api/src", "packages/web/src", "packages/scheduler/src")

REMOVAL_RE = re.compile(
    r"(remov(?:ed?|al)|dropped?|deleted?|goes away|go away)[^.\n]{0,30}"
    r"(?:next|following|subsequent) (?:minor |major |dot )?(?:release|version|minor)"
    r"|next release[^.\n]{0,20}(?:remov|drop|delet)",
    re.IGNORECASE,
)
ISSUE_RE = re.compile(r"#\d{2,6}")
MARKER_RE = re.compile(
    r"deprecated\s*=\s*True|[\"']deprecated[\"']\s*:\s*True|deprecated\s*:\s*true|"
    r"@deprecated|DeprecationWarning"
)
FOCUS_TRAP_RE = re.compile(r"useFocusTrap")
FOCUS_OK_RE = re.compile(r"focus-trap-ok:\s*\S")
DEPR_OK_RE = re.compile(r"deprecation-ok:\s*\S")


def is_test(rel: str) -> bool:
    return bool(
        re.search(r"\.test\.|\.spec\.|/tests?/|/__tests__/|/migrations/|/e2e/", rel)
    )


def iter_files(root: Path, base: str, suffixes: tuple[str, ...]):
    d = root / base
    if not d.is_dir():
        return
    for p in sorted(d.rglob("*")):
        if p.is_file() and p.suffix in suffixes:
            rel = p.relative_to(root).as_posix()
            if not is_test(rel):
                yield rel, p


def find_violations(root: Path) -> set[str]:
    """Return baseline-style keys: ``aria-modal <path>`` / ``deprecation <path>``."""
    out: set[str] = set()
    for rel, p in iter_files(root, WEB_SRC, (".tsx",)):
        text = p.read_text(encoding="utf-8", errors="replace")
        if (
            "aria-modal" in text
            and not FOCUS_TRAP_RE.search(text)
            and not FOCUS_OK_RE.search(text)
        ):
            out.add(f"aria-modal {rel}")
    for base in DEPRECATION_ROOTS:
        for rel, p in iter_files(root, base, (".py", ".ts", ".tsx")):
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
            text = "\n".join(lines)
            for i, line in enumerate(lines):
                if not REMOVAL_RE.search(line) or DEPR_OK_RE.search(line):
                    continue
                window = "\n".join(lines[max(0, i - 3) : i + 4])
                if not (ISSUE_RE.search(window) and MARKER_RE.search(text)):
                    out.add(f"deprecation {rel}")
                    break
    return out


def read_baseline(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    return {
        ln.strip()
        for ln in path.read_text().splitlines()
        if ln.strip() and not ln.lstrip().startswith("#")
    }


HEADER = (
    "# Unpaired files grandfathered by scripts/check-pairings.py (#4125).\n"
    "# Ratchet: entries may only be removed. Fix the file, then run\n"
    "#   python3 scripts/check-pairings.py --update-baseline\n"
)


def run(root: Path, baseline: Path, update: bool) -> int:
    found = find_violations(root)
    base = read_baseline(baseline)
    new = sorted(found - base)
    stale = sorted(base - found)
    if update:
        if new:
            print(
                "refusing to add entries to the baseline; fix these instead:",
                file=sys.stderr,
            )
            for k in new:
                print(f"  {k}", file=sys.stderr)
            return 1
        baseline.write_text(HEADER + "".join(f"{k}\n" for k in sorted(found)))
        print(f"baseline now {len(found)} entries (was {len(base)})")
        return 0
    rc = 0
    if new:
        rc = 1
        print("UNPAIRED (new):", file=sys.stderr)
        for k in new:
            kind, path = k.split(" ", 1)
            how = (
                "call useFocusTrap (hooks/useFocusTrap.ts), or add `focus-trap-ok: <reason>`"
                if kind == "aria-modal"
                else "add `deprecated: True` in the schema/field AND a `#NNNN` tracking issue "
                "beside the comment, or `deprecation-ok: <reason>` on the line"
            )
            print(f"  {path}: {kind} - {how}", file=sys.stderr)
    if stale:
        rc = 1
        print(
            "STALE baseline entries (now paired; run --update-baseline to lock in):",
            file=sys.stderr,
        )
        for k in stale:
            print(f"  {k}", file=sys.stderr)
    if rc == 0:
        print(f"OK: {len(found)} grandfathered, 0 new unpaired.")
    return rc


def self_test() -> int:
    def w(root: Path, rel: str, body: str) -> None:
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(body)

    def check(cond: bool, msg: str) -> None:
        if not cond:
            print(f"SELF-TEST FAILED: {msg}", file=sys.stderr)
            sys.exit(1)

    with tempfile.TemporaryDirectory() as t:
        root = Path(t)
        s = "packages/web/src/features/x"
        w(root, f"{s}/Bad.tsx", '<div role="dialog" aria-modal="true" />')
        w(root, f"{s}/Good.tsx", 'useFocusTrap(r); <div aria-modal="true" />')
        w(root, f"{s}/Opt.tsx", '// focus-trap-ok: popover\n<div aria-modal="true" />')
        w(root, f"{s}/Bad.test.tsx", '<div aria-modal="true" />')
        a = "packages/api/src/pkg"
        w(root, f"{a}/unpaired.py", "# alias is removed next release.\n")
        w(root, f"{a}/no_marker.py", "# removed next release (#1234)\n")
        w(
            root,
            f"{a}/paired.py",
            '# removed next release (#1234)\nX = {"deprecated": True}\n',
        )
        w(root, f"{a}/optout.py", "# removed next release  # deprecation-ok: env var\n")
        got = find_violations(root)
        check(
            got
            == {
                f"aria-modal {s}/Bad.tsx",
                f"deprecation {a}/unpaired.py",
                f"deprecation {a}/no_marker.py",
            },
            f"violation set wrong: {sorted(got)}",
        )
        bl = root / BASELINE_REL
        bl.parent.mkdir(parents=True, exist_ok=True)
        check(run(root, bl, False) == 1, "new violations with no baseline did not fail")
        bl.write_text(HEADER + "".join(f"{k}\n" for k in sorted(got)))
        check(run(root, bl, False) == 0, "a fully baselined tree did not pass")
        w(root, f"{s}/Worse.tsx", '<div aria-modal="true" />')
        check(run(root, bl, False) == 1, "a new violation beside a baseline passed")
        check(run(root, bl, True) == 1, "--update-baseline accepted an addition")
        (root / f"{s}/Worse.tsx").unlink()
        w(root, f"{s}/Bad.tsx", "useFocusTrap(r); aria-modal")
        check(
            run(root, bl, False) == 1,
            "a fixed-but-baselined file did not fail as stale",
        )
        check(run(root, bl, True) == 0, "--update-baseline refused a pure removal")
        check(run(root, bl, False) == 0, "tree not green after --update-baseline")
    print("self-test OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    ap.add_argument("--baseline", type=Path)
    ap.add_argument("--update-baseline", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    return run(a.root, a.baseline or a.root / BASELINE_REL, a.update_baseline)


if __name__ == "__main__":
    sys.exit(main())
