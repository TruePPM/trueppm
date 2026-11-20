#!/usr/bin/env python3
"""check-api-engine-boundary.py — the API does not reimplement engine math (#4688).

Why this exists. Every sampled, scheduled, or derived value the API serves must be
computed by a call into ``trueppm_scheduler`` (or ``wasm-scheduler`` under
conformance): the engine's oracle, mutation score and parity guarantees stop at the
library boundary. The API may select, filter, cache, paginate and serialize engine
output; it may not sample, expand, snap, floor or aggregate durations or dates. Three
violations of that rule were found by hand (#2645 velocity horizon cap, #4663 run
count under three names, #4660 ignored ``task_id``); nothing kept the class out.

What it checks. Over ``packages/api/src/trueppm_api`` (code tokens only — comments,
docstrings and string literals are ignored), four rules:

* ``np-random``      — ``np.random`` / ``numpy.random`` / ``default_rng``
* ``stdlib-random``  — ``import random`` / ``random.<fn>(``
* ``percentile``     — ``np.percentile`` / ``np.quantile`` / ``statistics.quantiles``
* ``timedelta-days`` — ``timedelta(days=`` arithmetic, minus clearly-not-schedule uses
  (``now()``/``localdate()`` cutoffs, ``weekday()`` week snaps, UPPER_CASE constants,
  ``lag=``/``duration=`` engine-input construction, ``days=0``)

A line may opt out with ``# engine-boundary-ok: <reason>`` on it or on the comment
line directly above (reason required).
Every remaining hit must be covered by an entry in ``ALLOWLIST`` (``packages/api/
api-engine-boundary-allowlist.txt``): ``path | rule | max-count | issue | reason``.

Ratchet. A count ABOVE the entry fails (a new hit); a count BELOW it fails too (lower
the number — the list only shrinks); an entry matching nothing fails (delete it).
Each entry must name an issue as ``#NNNN``.

What it deliberately does NOT check — read this before citing a green run:

* **Aliased imports.** ``import statistics as st; st.quantiles(...)`` and
  ``import numpy as n; n.percentile(...)`` are not matched (only ``np``/``numpy``/
  ``statistics`` spellings and the ``from X import Y`` forms are).
* **Clock keywords.** ``cutoff``/``retention``/``window`` exempt a ``timedelta`` line
  only when ``now``/``today`` is on the same line; ``w = now_ish_task_finish + ...``
  style names containing ``now``/``today`` could still slip through.
* **Semantics.** It matches spellings. Working-day walks written as ``d += 1`` loops,
  ``date.fromordinal`` arithmetic, ``calendar.monthrange``, hand-rolled mean/median,
  float/criticality derivation (``total_float <= 0``) and milestone rollup math are
  invisible to it; those were covered by the one-time audit inventory on #4688 only.
* **Other directories.** ``migrations/``, ``seed/``, ``management/commands/``,
  ``settings/`` and tests are skipped (demo data, one-shot commands and fixtures are
  not served values).
* **Whether an allow-listed issue is still open.** The issue is named, not queried.
* **A baseline raise relative to the merge base.** The allow-list can be edited
  upward in the same diff that adds a hit; review is the control, like
  ``# layering-ok:``.

Usage:  python3 scripts/check-api-engine-boundary.py [--self-test]
Exit:   0 clean · 1 unallowed hit, stale entry, or malformed entry
"""

from __future__ import annotations

import io
import os
import re
import sys
import tokenize
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = Path(
    os.environ.get("ENGINE_BOUNDARY_SRC", REPO_ROOT / "packages/api/src/trueppm_api")
)
ALLOWLIST = Path(
    os.environ.get(
        "ENGINE_BOUNDARY_ALLOWLIST",
        REPO_ROOT / "packages/api/api-engine-boundary-allowlist.txt",
    )
)

SKIP_PARTS = ("/migrations/", "/seed/", "/management/commands/", "/settings/")

RULES: dict[str, re.Pattern[str]] = {
    "np-random": re.compile(
        r"\b(?:np|numpy)\.random\b|\bdefault_rng\b"
        r"|^from(?:np|numpy)(?:\.random)?import(?:random|default_rng)\b|^importnumpy\.random"
    ),
    "stdlib-random": re.compile(
        r"(?:^(?:importrandom|fromrandomimport))|(?:(?<![\w.])random\.[A-Za-z_]+\()"
    ),
    "percentile": re.compile(
        r"\b(?:np|numpy)\.(?:nan)?(?:percentile|quantile)\b|\bstatistics\.(?:quantiles|median)\b"
        r"|^from(?:np|numpy)import(?:nan)?(?:percentile|quantile)\b"
        r"|^fromstatisticsimport(?:quantiles|median)\b"
    ),
    "timedelta-days": re.compile(r"\btimedelta\(days="),
}

# A timedelta(days=…) on these lines is wall-clock / calendar bookkeeping, not
# schedule math: cutoffs, week snaps, constants, and building engine INPUTS.
TIMEDELTA_BENIGN = re.compile(
    r"now\(\)|(?<![A-Za-z_])now[-+]|localdate\(\)|cutoff|weekday\(\)|\blag=|\bduration=|\bdays=0\)|(?-i:^[A-Z_][A-Z0-9_]*(?::[^=]+)?=)|^\w+(?::[^=]+)?=(?:datetime\.)?timedelta\(",
    re.IGNORECASE,
)
# cutoff/retention/window only count as bookkeeping when anchored to the wall clock on
# the same line, so ``window_start = task_finish + timedelta(days=n)`` is still flagged.
TIMEDELTA_CLOCK_KEYWORD = re.compile(r"cutoff|retention|window", re.IGNORECASE)
TIMEDELTA_CLOCK_ANCHOR = re.compile(r"now|today|utcnow", re.IGNORECASE)


# Per-line opt-out for a use that is provably not engine math (e.g. a timesheet's
# entry-date bounds). The reason is mandatory; like ``# layering-ok:`` it is a
# rubber stamp that removes the silence, not a proof.
OPT_OUT = re.compile(r"#\s*engine-boundary-ok:\s*\S")


def code_lines(text: str) -> dict[int, str]:
    """Map line number -> that line's code tokens joined without spaces.

    Comments, docstrings and string literals are dropped so prose that merely names
    ``np.percentile`` cannot trip the gate.
    """
    out: dict[int, list[str]] = {}
    skip = {
        tokenize.COMMENT,
        tokenize.STRING,
        tokenize.NL,
        tokenize.NEWLINE,
        tokenize.INDENT,
        tokenize.DEDENT,
        tokenize.ENDMARKER,
    }
    for name in ("FSTRING_START", "FSTRING_MIDDLE", "FSTRING_END"):
        if hasattr(tokenize, name):
            skip.add(getattr(tokenize, name))
    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type in skip:
                continue
            out.setdefault(tok.start[0], []).append(tok.string)
    except (tokenize.TokenError, IndentationError):
        pass
    return {n: "".join(parts) for n, parts in out.items()}


def scan(src: Path) -> Counter[tuple[str, str]]:
    """Count rule hits per (path-relative-to-src, rule)."""
    hits: Counter[tuple[str, str]] = Counter()
    for path in sorted(src.rglob("*.py")):
        posix = "/" + path.relative_to(src.parent).as_posix()
        if any(part in posix for part in SKIP_PARTS):
            continue
        rel = path.relative_to(src).as_posix()
        source = path.read_text(encoding="utf-8", errors="replace")
        raw = source.splitlines()
        for lineno, text in code_lines(source).items():
            if OPT_OUT.search(raw[lineno - 1]) or (
                lineno > 1
                and raw[lineno - 2].lstrip().startswith("#")
                and OPT_OUT.search(raw[lineno - 2])
            ):
                continue
            for rule, pat in RULES.items():
                if not pat.search(text):
                    continue
                if rule == "timedelta-days" and (
                    TIMEDELTA_BENIGN.search(text)
                    or (
                        TIMEDELTA_CLOCK_KEYWORD.search(text)
                        and TIMEDELTA_CLOCK_ANCHOR.search(text)
                    )
                ):
                    continue
                hits[(rel, rule)] += 1
    return hits


def load_allowlist(
    path: Path,
) -> tuple[dict[tuple[str, str], tuple[int, str]], list[str]]:
    entries: dict[tuple[str, str], tuple[int, str]] = {}
    problems: list[str] = []
    if not path.exists():
        return entries, [f"allow-list missing: {path}"]
    for n, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 5 or not parts[2].isdigit() or not parts[4]:
            problems.append(
                f"{path.name}:{n}: expected 'path | rule | count | issue | reason'"
            )
            continue
        file, rule, count, issue, _reason = parts
        if rule not in RULES:
            problems.append(f"{path.name}:{n}: unknown rule {rule!r}")
        if not (re.fullmatch(r"#\d+", issue)):
            problems.append(f"{path.name}:{n}: issue must be '#NNNN', got {issue!r}")
        entries[(file, rule)] = (int(count), issue)
    return entries, problems


def evaluate(
    hits: Counter[tuple[str, str]], entries: dict[tuple[str, str], tuple[int, str]]
) -> list[str]:
    errors: list[str] = []
    for key in sorted(set(hits) | set(entries)):
        got = hits.get(key, 0)
        allowed = entries.get(key, (0, ""))[0]
        file, rule = key
        if got > allowed:
            errors.append(
                f"{file}: {got} '{rule}' hit(s), {allowed} allowed — compute it with a "
                "trueppm_scheduler call, or add an allow-list entry naming an open issue"
            )
        elif got < allowed:
            errors.append(
                f"{file}: '{rule}' now has {got} hit(s) but the allow-list says {allowed} — "
                "lower the count (or delete the entry); the list only shrinks"
            )
    return errors


def main() -> int:
    entries, problems = load_allowlist(ALLOWLIST)
    errors = problems + evaluate(scan(SRC), entries)
    if errors:
        print("api-engine-boundary: FAIL")
        for e in errors:
            print(f"  {e}")
        return 1
    print(
        f"api-engine-boundary: ok ({sum(c for c, _ in entries.values())} allow-listed hits)"
    )
    return 0


def self_test() -> int:
    import tempfile

    failures: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "trueppm_api"
        (src / "apps/x").mkdir(parents=True)
        bad = src / "apps/x/bad.py"
        bad.write_text(
            "import numpy as np\n"
            "def f(x, d):\n"
            "    rng = np.random.default_rng(1)\n"
            "    p = np.percentile(x, 80)\n"
            "    return d.cpm_finish + timedelta(days=3)\n"
        )
        clean = src / "apps/x/clean.py"
        clean.write_text(
            '"""Mentions np.random and np.percentile in prose only."""\n'
            "# np.percentile(x, 5) in a comment\n"
            "def g(now):\n"
            "    s = 'np.random.default_rng'\n"
            "    return now() - timedelta(days=7)\n"
            "def h(d):\n"
            "    return d + timedelta(days=1)  # engine-boundary-ok: entry-date bound\n"
        )
        hits = scan(src)
        if not {
            ("apps/x/bad.py", r) for r in ("np-random", "percentile", "timedelta-days")
        } <= set(hits):
            failures.append(f"planted violation not detected: {dict(hits)}")
        if any(f == "apps/x/clean.py" for f, _ in hits):
            failures.append("clean file was flagged")
        if not evaluate(hits, {}):
            failures.append("unallowed hits did not fail")
        allow = {k: (c, "#1") for k, c in hits.items()}
        if evaluate(hits, allow):
            failures.append("exact allow-list did not pass")
        allow[("apps/x/bad.py", "np-random")] = (5, "#1")
        if not evaluate(hits, allow):
            failures.append("stale (too-high) entry did not fail")
        forms = {
            "np-random": [
                "from numpy.random import default_rng",
                "from numpy import random",
                "import numpy.random as r",
            ],
            "percentile": [
                "from numpy import percentile",
                "from numpy import quantile",
                "from statistics import quantiles",
            ],
            "timedelta-days": ["window_start = task_finish + timedelta(days=n)"],
        }
        for rule, lines in forms.items():
            for i, line in enumerate(lines):
                d = Path(tmp) / f"forms_{rule}_{i}" / "trueppm_api"
                d.mkdir(parents=True)
                (d / "m.py").write_text(line + "\n")
                if ("m.py", rule) not in scan(d):
                    failures.append(f"{rule} form not detected: {line}")
        bad.write_text("x = 1\n")
        if not evaluate(scan(src), {("apps/x/bad.py", "np-random"): (1, "#1")}):
            failures.append("entry matching nothing did not fail")
    if failures:
        print("self-test FAILED:\n  " + "\n  ".join(failures))
        return 1
    print("self-test ok")
    return 0


if __name__ == "__main__":
    sys.exit(self_test() if "--self-test" in sys.argv else main())
