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
    r"|next release[^.\n]{0,20}(?:remov|drop|delet)"
    # Forward-looking phrasings (#4125 audit). Plain past-tense "was removed"
    # deliberately does not match: it is history, not a promise.
    r"|\bwill (?:also |then )?be (?:removed|dropped|deleted)"
    r"(?=\s*[;,)]|\s+(?:in|at|entirely|soon|once|when|after|before)\b)"
    r"|\bremov(?:ed?|al)\b[^.\n]{0,20}\bin (?:a |the )?(?:later|future|subsequent) "
    r"(?:minor |major |dot )?(?:release|version|minor)"
    r"|\bremov(?:ed?|al)\b[^.\n]{0,20}\bat v?\d+\.\d+",
    re.IGNORECASE,
)
ISSUE_RE = re.compile(r"#\d{2,6}")
MARKER_RE = re.compile(
    r"deprecated\s*=\s*True|[\"']deprecated[\"']\s*:\s*True|deprecated\s*:\s*true|"
    r"@deprecated|DeprecationWarning"
)
ARIA_MODAL_ATTR_RE = re.compile(r"[\"']?aria-modal[\"']?\s*[=:]")
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


def removal_starts_on(lines: list[str], i: int) -> bool:
    """True if a removal promise begins on line ``i``.

    The next line is joined on so a promise wrapped across two string literals
    ("Removed in a later " / "minor release.") is seen; a match counts only when
    it starts on line ``i`` so a wrapped promise is one site, not two.
    """
    nxt = re.sub(r"^\s*[\"'#/*]*\s*", "", lines[i + 1]) if i + 1 < len(lines) else ""
    cur = re.sub(r"[\"']\s*$", "", lines[i]).rstrip()
    m = REMOVAL_RE.search(cur + " " + nxt)
    return bool(m) and m.start() < len(cur)


def find_violations(root: Path) -> dict[str, int]:
    """Return baseline-style ``key -> site count``.

    Keys are ``aria-modal <path>`` / ``deprecation <path>``. The count is per
    site (each ``aria-modal`` occurrence, each unpaired removal promise) so a
    baselined file cannot gain a second violation and stay green.
    """
    out: dict[str, int] = {}
    for rel, p in iter_files(root, WEB_SRC, (".tsx",)):
        text = p.read_text(encoding="utf-8", errors="replace")
        # Count real attributes (`aria-modal=` / `aria-modal:`), not comment or
        # prose mentions, so explaining the attribute never adds a site.
        sites = len(ARIA_MODAL_ATTR_RE.findall(text))
        if sites and not FOCUS_TRAP_RE.search(text) and not FOCUS_OK_RE.search(text):
            out[f"aria-modal {rel}"] = sites
    for base in DEPRECATION_ROOTS:
        for rel, p in iter_files(root, base, (".py", ".ts", ".tsx")):
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
            text = "\n".join(lines)
            sites = 0
            for i, line in enumerate(lines):
                if not removal_starts_on(lines, i) or DEPR_OK_RE.search(line):
                    continue
                window = "\n".join(lines[max(0, i - 3) : i + 4])
                if not (ISSUE_RE.search(window) and MARKER_RE.search(text)):
                    sites += 1
            if sites:
                out[f"deprecation {rel}"] = sites
    return out


def read_baseline(path: Path) -> dict[str, int]:
    """Parse ``<rule> <path> <count>`` lines (a bare ``<rule> <path>`` is 1)."""
    out: dict[str, int] = {}
    if not path.is_file():
        return out
    for ln in path.read_text().splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        head, _, tail = ln.rpartition(" ")
        if tail.isdigit() and " " in head:
            out[head] = int(tail)
        else:
            out[ln] = 1
    return out


HEADER = (
    "# Unpaired sites grandfathered by scripts/check-pairings.py (#4125).\n"
    "# Format: <rule> <path> <site count>. A grandfathered snapshot, NOT a review:\n"
    "# nobody has verified these files. Ratchet: a count may only fall. Fix the\n"
    "# file, then run\n"
    "#   python3 scripts/check-pairings.py --update-baseline\n"
)


def run(root: Path, baseline: Path, update: bool) -> int:
    found = find_violations(root)
    base = read_baseline(baseline)
    new = sorted(k for k, n in found.items() if n > base.get(k, 0))
    stale = sorted(k for k, n in base.items() if found.get(k, 0) < n)
    if update:
        if new:
            print(
                "refusing to add or raise baseline entries; fix these instead:",
                file=sys.stderr,
            )
            for k in new:
                print(f"  {k} ({base.get(k, 0)} -> {found[k]})", file=sys.stderr)
            return 1
        baseline.write_text(
            HEADER + "".join(f"{k} {found[k]}\n" for k in sorted(found))
        )
        print(f"baseline now {len(found)} entries (was {len(base)})")
        return 0
    rc = 0
    if new:
        rc = 1
        print("UNPAIRED (new or more sites than baselined):", file=sys.stderr)
        for k in new:
            kind, path = k.split(" ", 1)
            how = (
                "call useFocusTrap (hooks/useFocusTrap.ts), or add `focus-trap-ok: <reason>`"
                if kind == "aria-modal"
                else "add `deprecated: True` in the schema/field AND a `#NNNN` tracking issue "
                "beside the comment, or `deprecation-ok: <reason>` on the line"
            )
            print(
                f"  {path}: {kind} - {found[k]} site(s), baseline {base.get(k, 0)} - {how}",
                file=sys.stderr,
            )
    if stale:
        rc = 1
        print(
            "STALE baseline entries (fewer sites now; run --update-baseline to lock in):",
            file=sys.stderr,
        )
        for k in stale:
            print(f"  {k} ({base[k]} -> {found.get(k, 0)})", file=sys.stderr)
    if rc == 0:
        print(f"OK: {len(found)} grandfathered files, 0 new unpaired.")
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
        # Widened phrasings (#4125 audit): each unpaired, one file apiece.
        w(root, f"{a}/will_be.py", "# the alias will be removed at 1.0.\n")
        w(root, f"{a}/will_be2.py", 'MSG = "kept and will be removed; use X."\n')
        w(root, f"{a}/later.py", 'D = ("Removed in a later "\n     "minor release.")\n')
        w(root, f"{a}/at_ver.py", "# gone: removed at 1.0\n")
        w(
            root,
            f"{a}/later_paired.py",
            'D = {"deprecated": True, "d": ("Alias (#4663). Removed in a later "\n'
            '"minor release.")}\n',
        )
        # Negatives: history, and UI copy about user data, are not promises.
        w(root, f"{a}/history.py", "# the old alias was removed in 0.3; was removed.\n")
        w(root, f"{a}/ui_copy.py", 'T = "Your item will be removed from the board."\n')
        got = find_violations(root)
        check(
            got
            == {
                f"aria-modal {s}/Bad.tsx": 1,
                f"deprecation {a}/unpaired.py": 1,
                f"deprecation {a}/no_marker.py": 1,
                f"deprecation {a}/will_be.py": 1,
                f"deprecation {a}/will_be2.py": 1,
                f"deprecation {a}/later.py": 1,
                f"deprecation {a}/at_ver.py": 1,
            },
            f"violation set wrong: {sorted(got.items())}",
        )
        bl = root / BASELINE_REL
        bl.parent.mkdir(parents=True, exist_ok=True)
        check(run(root, bl, False) == 1, "new violations with no baseline did not fail")
        bl.write_text(HEADER + "".join(f"{k} {n}\n" for k, n in sorted(got.items())))
        check(run(root, bl, False) == 0, "a fully baselined tree did not pass")
        # A baselined file gaining a second site must fail (per-site, not per-file).
        w(
            root,
            f"{a}/unpaired.py",
            "# alias is removed next release.\n# also removed next release.\n",
        )
        check(
            run(root, bl, False) == 1,
            "baselined file gaining a second violation passed",
        )
        check(run(root, bl, True) == 1, "--update-baseline accepted a raised count")
        w(root, f"{a}/unpaired.py", "# alias is removed next release.\n")
        w(root, f"{s}/Bad.tsx", '<div aria-modal="true" /><div aria-modal="true" />')
        check(
            run(root, bl, False) == 1, "a second aria-modal in a baselined file passed"
        )
        w(root, f"{s}/Bad.tsx", '<div role="dialog" aria-modal="true" />')
        w(root, f"{s}/Worse.tsx", '<div aria-modal="true" />')
        check(run(root, bl, False) == 1, "a new violation beside a baseline passed")
        check(run(root, bl, True) == 1, "--update-baseline accepted an addition")
        (root / f"{s}/Worse.tsx").unlink()
        w(
            root,
            f"{s}/Prose.tsx",
            "// aria-modal is explained here, never set\nconst x = 1;",
        )
        check(
            f"aria-modal {s}/Prose.tsx" not in find_violations(root),
            "a prose-only aria-modal mention counted as a site",
        )
        (root / f"{s}/Prose.tsx").unlink()
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
