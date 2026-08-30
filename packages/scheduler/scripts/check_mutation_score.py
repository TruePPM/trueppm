#!/usr/bin/env python3
"""Compute and (optionally) gate the scheduler's mutation score.

``mutmut export-cicd-stats`` writes ``mutants/mutmut-cicd-stats.json`` with the
per-verdict mutant counts. This script turns those counts into a single mutation
score and, when a floor is configured, exits non-zero if the score drops below
it — the same "report first, gate later" shape as the fuzz jobs (#2121): the
nightly ``scheduler:mutation`` job establishes a baseline before anyone commits a
hard floor.

The score deliberately excludes ``no_tests`` and ``skipped`` mutants. A mutant on
a line no test covers is a *coverage* gap — already the coverage gate's job — not
an assertion-strength gap, which is the only thing mutation testing is here to
measure.

Usage::

    python scripts/check_mutation_score.py mutants/mutmut-cicd-stats.json
    python scripts/check_mutation_score.py --self-test

``--self-test`` runs this script — the real one, as a subprocess, so what it
observes is the exit code the CI job would see — against fixture stats files and
asserts it still both accepts and *rejects*. It exists because
``scheduler:mutation`` is the shape of gate that fails silently: it is
schedule-only, ``allow_failure: true``, and configured ``MUTATION_MIN: "0"``, so
every real run of it exits 0 by construction. A gate whose green is unconditional
is indistinguishable from one whose comparison has been inverted (#3194/#3195).
``tests/test_mutation_score.py`` covers the same ground, but it runs in a
different job and therefore a different image — which is precisely what made the
#3172 test suite evidence about nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_STATS_PATH = Path("mutants") / "mutmut-cicd-stats.json"


def compute_score(stats: dict[str, int]) -> float | None:
    """Return the mutation score in ``[0, 1]``, or ``None`` if nothing was scored.

    Args:
        stats: The counts emitted by ``mutmut export-cicd-stats`` (keys such as
            ``killed``, ``survived``, ``timeout``, ``suspicious``, ``segfault``,
            ``no_tests``, ``skipped``).

    Returns:
        ``detected / considered`` where ``detected`` is killed + timeout (a mutant
        that hangs the suite is caught by the per-mutant timeout, so it counts as
        killed) and ``considered`` is every mutant that actually ran and had a
        chance to be killed. ``suspicious`` and ``segfault`` are counted as *not*
        detected — they are ambiguous outcomes, so scoring them conservatively
        keeps the number honest. Returns ``None`` when no mutant was scoreable
        (empty run), so the caller can treat "nothing to measure" differently from
        "everything survived".
    """
    killed = stats.get("killed", 0)
    timeout = stats.get("timeout", 0)
    survived = stats.get("survived", 0)
    suspicious = stats.get("suspicious", 0)
    segfault = stats.get("segfault", 0)

    detected = killed + timeout
    considered = detected + survived + suspicious + segfault
    if considered == 0:
        return None
    return detected / considered


def _format_summary(stats: dict[str, int], score: float | None) -> str:
    lines = [
        "Mutation testing summary (scheduler beachhead: models.py, derive.py, cli.py)",
        f"  killed:     {stats.get('killed', 0)}",
        f"  timeout:    {stats.get('timeout', 0)}  (counted as killed)",
        f"  survived:   {stats.get('survived', 0)}",
        f"  suspicious: {stats.get('suspicious', 0)}",
        f"  segfault:   {stats.get('segfault', 0)}",
        f"  no_tests:   {stats.get('no_tests', 0)}  (excluded — coverage gap, not assertion gap)",
        f"  skipped:    {stats.get('skipped', 0)}  (excluded)",
    ]
    if score is None:
        lines.append("  score:      n/a (no scoreable mutants)")
    else:
        lines.append(f"  score:      {score:.1%}")
    return "\n".join(lines)


def _run_real_script(stats_path: Path, floor: str) -> int:
    """Invoke this script as a subprocess and return its exit code.

    A subprocess rather than a call to :func:`main` for two reasons. It is the
    exact command ``scheduler:mutation`` runs, so the self-test measures the gate
    as CI invokes it; and an unparseable stats file raises out of ``json.loads``,
    which in-process would abort the self-test instead of being observed as the
    non-zero exit it actually is.
    """
    completed = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(stats_path), "--min", floor],
        capture_output=True,
        text=True,
    )
    return completed.returncode


def _self_test() -> int:
    """Prove the gate still rejects. A guard nobody has watched fail is not a guard.

    Both directions, and the boundary between them: ``>=`` silently becoming ``>``
    (or the comparison vanishing entirely) is the mutation that turns this into a
    gate that always passes, and only the at-floor and one-below cases catch it.
    """
    # 80 killed / 100 considered = 0.80 exactly — the at-floor case. 79/100 is one
    # mutant below it. If a single mutant does not flip the verdict, the boundary
    # is wrong.
    at_floor = {"killed": 80, "survived": 20}
    below_floor = {"killed": 79, "survived": 21}

    cases: dict[str, tuple[str, str, int]] = {
        # name: (fixture json, --min, expected exit code)
        "a score above the floor": (json.dumps({"killed": 95, "survived": 5}), "0.8", 0),
        "a score exactly at the floor": (json.dumps(at_floor), "0.8", 0),
        "a score one mutant below the floor": (json.dumps(below_floor), "0.8", 1),
        "a score far below the floor": (json.dumps({"killed": 1, "survived": 99}), "0.9", 1),
        # no_tests/skipped are excluded from the denominator by design, so a run
        # that is 5/5 on what it scored passes a 0.9 floor despite 80 uncovered
        # mutants. That is the coverage gate's job, not this one.
        "uncovered mutants excluded from the denominator": (
            json.dumps({"killed": 5, "survived": 0, "no_tests": 80, "skipped": 10}),
            "0.9",
            0,
        ),
        # An unparseable stats file must not read as a pass. It currently exits
        # non-zero via an uncaught JSONDecodeError; the assertion below is on the
        # exit code, not the traceback, so tidying that up later stays green.
        "an unparseable stats file": ("{ not json", "0.8", 1),
        # DOCUMENTED, NOT ENDORSED. Both of the following exit 0 today, and both
        # are a green that means "not measured" rather than "measured and fine" —
        # the #3172 shape. They are asserted so the behavior is on the record and
        # a deliberate change to it has to come here and say so.
        "an empty run at a real floor (exits 0 — 'nothing to gate')": ('{"no_tests": 5}', "0.9", 0),
        "a terrible score at floor 0 (exits 0 — report-only, the CI setting)": (
            json.dumps({"killed": 1, "survived": 99}),
            "0",
            0,
        ),
    }

    rc = 0
    with tempfile.TemporaryDirectory() as tmp:
        stats_path = Path(tmp) / "mutmut-cicd-stats.json"
        for name, (body, floor, expected) in cases.items():
            stats_path.write_text(body, "utf-8")
            actual = _run_real_script(stats_path, floor)
            if actual != expected:
                print(
                    f"SELF-TEST FAILED: {name} exited {actual}, expected {expected}",
                    file=sys.stderr,
                )
                rc = 1

        # A stats file that was never written must not read as a pass either — an
        # absent mutmut run is the loudest "never measured" there is.
        missing = _run_real_script(Path(tmp) / "nope.json", "0.8")
        if missing != 2:
            print(
                f"SELF-TEST FAILED: a missing stats file exited {missing}, expected 2",
                file=sys.stderr,
            )
            rc = 1

    if rc == 0:
        print(
            f"SELF-TEST OK: all {len(cases) + 1} cases passed "
            "(above, at, below, absent, malformed)."
        )
    return rc


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns the process exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "stats_path",
        nargs="?",
        type=Path,
        default=DEFAULT_STATS_PATH,
        help=f"Path to mutmut-cicd-stats.json (default: {DEFAULT_STATS_PATH})",
    )
    parser.add_argument(
        "--min",
        type=float,
        default=float(os.environ.get("MUTATION_MIN", "0") or "0"),
        help=(
            "Minimum acceptable mutation score in [0, 1]. Below this the check "
            "fails. Defaults to $MUTATION_MIN, or 0 (report-only) if unset."
        ),
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="prove this check can still fail, then exit (reads no real stats file)",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test()

    if not args.stats_path.exists():
        print(f"error: stats file not found: {args.stats_path}", file=sys.stderr)
        return 2

    stats = json.loads(args.stats_path.read_text("utf-8"))
    score = compute_score(stats)
    print(_format_summary(stats, score))

    if args.min <= 0:
        print("floor: report-only (MUTATION_MIN unset or 0) — not gating")
        return 0
    if score is None:
        print("floor: no scoreable mutants — nothing to gate")
        return 0
    if score < args.min:
        print(f"FAIL: score {score:.1%} is below the floor {args.min:.1%}")
        return 1
    print(f"OK: score {score:.1%} meets the floor {args.min:.1%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
