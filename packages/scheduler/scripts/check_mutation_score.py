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
"""

from __future__ import annotations

import argparse
import json
import os
import sys
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
    args = parser.parse_args(argv)

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
