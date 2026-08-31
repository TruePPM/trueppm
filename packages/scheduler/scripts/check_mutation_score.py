#!/usr/bin/env python3
"""Compute and gate the scheduler's mutation score.

``mutmut export-cicd-stats`` writes ``mutants/mutmut-cicd-stats.json`` with the
per-verdict mutant counts. This script turns those counts into a single mutation
score and exits non-zero if the score drops below the configured floor.

The score deliberately excludes ``no_tests`` and ``skipped`` mutants. A mutant on
a line no test covers is a *coverage* gap — already the coverage gate's job — not
an assertion-strength gap, which is the only thing mutation testing is here to
measure.

Usage::

    python scripts/check_mutation_score.py mutants/mutmut-cicd-stats.json
    python scripts/check_mutation_score.py --self-test

THE EXIT-CODE CONTRACT (#3216)
------------------------------

Three outcomes, and the distinction between the last two is the whole point:

====  ============================================================
exit  meaning
====  ============================================================
0     measured, and at or above the floor — or ``--min <= 0``,
      where no floor was requested and nothing was being gated
1     **measured, and below the floor** — a real regression
2     **could not be measured** — the stats file is missing,
      unparseable, not a JSON object, or carries zero scoreable
      mutants while a floor was requested
====  ============================================================

Exit 2 is fail-closed and it is not theoretical. Before #3216, a stats file with
no killed and no survived mutants returned 0 at any floor, printing "no scoreable
mutants — nothing to gate". That is the #3172 shape: a green that means "never
measured" is indistinguishable from a green that means "measured and healthy".

It fired. ``scheduler:mutation`` measured **nothing on thirteen consecutive
nightlies**, 2026-08-18 through 2026-08-30, and every one of them was green.
mutmut's stats pass runs the suite once before mutating anything; a test added in
#2837 read ``CHANGELOG.md`` off the package root, that file was not in
``[tool.mutmut] also_copy``, the run died with ``failed to collect stats``, the
job's ``|| true`` swallowed it, and ``export-cicd-stats`` wrote
``{"killed": 0, "survived": 0}``. Every mutant in the artifact read ``not
checked``. Nothing anywhere said so.

The counter-argument weighed and rejected: an empty run *can* be a legitimate
transient (mutmut crashed, the run was cut short), and failing on one reds a
schedule nobody can act on. Two things decide it against. A transient is not what
this repo produced — it produced a thirteen-day silent regression that exit 0
concealed for its entire duration. And exit 2 is precisely actionable: it says
the floor could not be evaluated, which is a different instruction from exit 1's
"the floor was evaluated and you are under it".

``--min <= 0`` keeps exit 0 on an empty run, because there a floor was never
requested and there is nothing to fail closed *on*.

WHY --self-test EXISTS
----------------------

It runs this script — the real one, as a subprocess, so what it observes is the
exit code the CI job would see — against fixture stats files and asserts it still
both accepts and *rejects*. ``tests/test_mutation_score.py`` covers the same
ground, but it runs in a different job and therefore a different image, which is
precisely what made the #3172 test suite evidence about nothing (#3194/#3195).
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
        (empty run). ``None`` is "nothing was measured", which is a different fact
        from "everything survived" and from "everything was killed"; :func:`main`
        turns it into exit 2 whenever a floor was requested (#3216).
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

    A subprocess rather than a call to :func:`main` because it is the exact
    command ``scheduler:mutation`` runs, so what the self-test observes is the
    exit code CI observes — including any future path that exits the interpreter
    rather than returning, which an in-process call would swallow or die on.
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
        # THE THREE "NOT MEASURED" STATES ALL EXIT 2 (#3216). They used to
        # disagree — missing exited 2, unparseable exited 1 through an uncaught
        # JSONDecodeError, and zero-scoreable exited 0. The last of those was a
        # green meaning "never measured", and it ran for thirteen nightlies. The
        # exit code now separates "could not evaluate the floor" (2) from
        # "evaluated the floor and failed it" (1), so a reader of a red job knows
        # which of the two things to go fix.
        "an unparseable stats file": ("{ not json", "0.8", 2),
        "a stats file holding a JSON array rather than an object": ("[1, 2, 3]", "0.8", 2),
        "an empty run at a real floor": ('{"no_tests": 5}', "0.9", 2),
        # THE REGRESSION AS IT ACTUALLY SHIPPED: mutmut's stats pass died, so
        # export-cicd-stats wrote every verdict as 0 while `total` stayed at the
        # generated-mutant count. This exact body went green thirteen times.
        "the shape the 2026-08 blind nightlies wrote": (
            json.dumps({"killed": 0, "survived": 0, "total": 1120, "no_tests": 0}),
            "0.92",
            2,
        ),
        # ...but only when a floor was requested. At --min 0 nothing was being
        # gated, so there is nothing to fail closed on.
        "an empty run at floor 0": ('{"no_tests": 5}', "0", 0),
        "a terrible score at floor 0 (report-only)": (
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
            "(above, at, below, absent, malformed, unmeasured)."
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
        print(
            f"NOT MEASURED: stats file not found: {args.stats_path}\n"
            "  Did `mutmut export-cicd-stats` run? An absent stats file is the "
            "loudest 'never measured' there is.",
            file=sys.stderr,
        )
        return 2

    # Both failure shapes, separately: a truncated/garbage file raises out of
    # json.loads, and a valid JSON *array* or scalar parses fine and then blows up
    # on `.get` two frames away, naming a symptom instead of the cause.
    try:
        stats = json.loads(args.stats_path.read_text("utf-8"))
    except json.JSONDecodeError as exc:
        print(
            f"NOT MEASURED: {args.stats_path} is not valid JSON: {exc}\n"
            "  A stats file mutmut could not finish writing is not a passing run.",
            file=sys.stderr,
        )
        return 2
    if not isinstance(stats, dict):
        print(
            f"NOT MEASURED: {args.stats_path} holds {type(stats).__name__}, "
            "expected a JSON object of per-verdict counts.",
            file=sys.stderr,
        )
        return 2

    score = compute_score(stats)
    print(_format_summary(stats, score))

    if args.min <= 0:
        # No floor was requested, so there is nothing to fail closed on — this
        # branch is report-only whether or not anything was scoreable.
        print("floor: report-only (--min/MUTATION_MIN is 0) — not gating")
        return 0
    if score is None:
        # FAIL CLOSED (#3216). A floor was requested and could not be evaluated.
        # Exit 2, not 1: the distinction between "measured and under" and "not
        # measured at all" is the entire finding, and collapsing them here would
        # re-lose it in the other direction.
        print(
            f"NOT MEASURED: a floor of {args.min:.1%} was requested but no mutant was "
            "scoreable.\n"
            "  mutmut ran nothing, or its stats pass died before mutating. Check the "
            "job log for `failed to collect stats`, then check that every repo file "
            "the suite reads is listed in [tool.mutmut] also_copy.",
            file=sys.stderr,
        )
        return 2
    if score < args.min:
        print(f"FAIL: score {score:.1%} is below the floor {args.min:.1%}")
        return 1
    print(f"OK: score {score:.1%} meets the floor {args.min:.1%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
