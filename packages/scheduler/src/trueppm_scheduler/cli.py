"""Command-line interface for trueppm-scheduler."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from trueppm_scheduler.engine import monte_carlo, schedule
from trueppm_scheduler.models import Project


def _needs_escape(cp: int) -> bool:
    return (
        cp < 0x20
        or 0x7F <= cp <= 0x9F  # DEL and C1 controls
        or 0xD800 <= cp <= 0xDFFF  # lone surrogates: print() cannot encode them
        or 0x200B <= cp <= 0x200F  # zero-width space/joiners, LRM, RLM
        or 0x2028 <= cp <= 0x202E  # line/paragraph separators, bidi embeddings/overrides
        or 0x2066 <= cp <= 0x2069  # bidi isolates
        or cp == 0xFEFF  # BOM / zero-width no-break space
        or 0x2060 <= cp <= 0x2064  # word joiner and invisible operators
        or cp in (0x00AD, 0x061C, 0x180E)  # soft hyphen, Arabic letter mark, Mongolian vowel sep.
        or 0xFFF9 <= cp <= 0xFFFB  # interlinear annotation anchors
        or 0xE0000 <= cp <= 0xE007F  # tag characters (invisible ASCII smuggling)
    )


def _display(value: object) -> str:
    """Make a document-derived string safe to print to a terminal.

    A project file is untrusted input, and JSON permits control characters
    inside strings. Printed raw, ESC sequences can retitle the window (OSC 0),
    clear the screen (CSI 2J), hide text (CSI 8m) or write the clipboard
    (OSC 52), and bidi or zero-width characters can reorder or hide a task
    name, spoofing the schedule a user reads (CWE-150). Escaped, with a visible
    ``\\xNN`` (code points below 0x100) or ``\\uNNNN`` form rather than U+FFFD so
    the output stays diagnosable: C0 controls (0x00-0x1F), DEL and C1 controls
    (0x7F-0x9F), lone surrogates (U+D800-U+DFFF, which would otherwise make
    ``print`` raise UnicodeEncodeError), U+200B-U+200F, U+2028-U+202E,
    U+2066-U+2069, U+FEFF, U+2060-U+2064, U+00AD, U+061C, U+180E,
    U+FFF9-U+FFFB and the tag block U+E0000-U+E007F (code points above 0xFFFF
    use ``\\UNNNNNNNN``). ZWJ and ZWNJ (U+200C/U+200D) are escaped on purpose:
    they can hide text, and the cost is that emoji ZWJ sequences and
    Persian/Indic ZWNJ text show as visible escapes in the human output. Only the human
    output needs this; ``--json`` is already escaped by ``json.dumps``.

    Args:
        value: Any value; it is converted with ``str()`` first (so exceptions
            and paths can be passed directly).

    Returns:
        The string with none of the characters above present.
    """
    return "".join(
        (
            f"\\x{ord(c):02x}"
            if ord(c) < 0x100
            else f"\\u{ord(c):04x}"
            if ord(c) < 0x10000
            else f"\\U{ord(c):08x}"
        )
        if _needs_escape(ord(c))
        else c
        for c in str(value)
    )


def _load_project(path: str) -> Project:
    try:
        text = Path(path).read_text()
    except OSError as e:
        print(f"error: cannot read {_display(repr(path))}: {_display(e)}", file=sys.stderr)
        sys.exit(1)
    try:
        return Project.from_json(text)
    except (KeyError, ValueError) as e:
        print(f"error: invalid project file: {_display(e)}", file=sys.stderr)
        sys.exit(1)


def _cmd_schedule(args: argparse.Namespace) -> None:
    project = _load_project(args.project)
    try:
        result = schedule(project)
    except Exception as e:
        print(f"error: {_display(e)}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(result.to_dict(), indent=2))
        return

    print(f"\nProject: {_display(project.name)}")
    print(f"Start:   {result.project_start}  Finish: {result.project_finish}")
    # The finish is the deterministic earliest-feasible date, not a commitment
    # date. Saying so here is the only chance a CLI user gets to learn it before
    # pasting the number into a status report.
    print("         (earliest feasible — run 'monte-carlo' for confidence dates)\n")
    header = f"{'ID':<20} {'Name':<30} {'ES':<12} {'EF':<12} {'LS':<12} {'LF':<12} {'TF':>4}  CP"
    print(header)
    print("-" * len(header))
    for task in result.tasks:
        cp = " *" if task.is_critical else ""
        tf = task.total_float.days if task.total_float else 0
        print(
            f"{_display(task.id):<20} {_display(task.name):<30} "
            f"{task.early_start!s:<12} {task.early_finish!s:<12} "
            f"{task.late_start!s:<12} {task.late_finish!s:<12} "
            f"{tf:>4}{cp}"
        )
    print(f"\nCritical path: {' → '.join(_display(t) for t in result.critical_path)}")


def _cmd_monte_carlo(args: argparse.Namespace) -> None:
    project = _load_project(args.project)
    try:
        # The library no longer caps runs/tasks by default; a local CLI run wants
        # no cap, so we leave max_runs/max_tasks at their default of None.
        result = monte_carlo(project, runs=args.runs, seed=args.seed)
    except Exception as e:
        print(f"error: {_display(e)}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        out = result.to_dict()
        if not args.distribution:
            del out["distribution"]
        print(json.dumps(out, indent=2))
        return

    print(f"\nMonte Carlo — {result.runs:,} runs  ({_display(project.name)})\n")
    print(f"  P50 (median):  {result.p50}   midpoint — even odds, not a commitment")
    print(f"  P80:           {result.p80}   ← commit to this date")
    print(f"  P95:           {result.p95}   external or contractual deadlines")
    # A collapsed distribution is a correct result (nothing in the plan varies),
    # but reads as a broken simulation unless it says so — the same reason the
    # web forecast bar carries a diagnostic for this case.
    if result.p50 == result.p80 == result.p95:
        print(
            "\n  Every run finished on the same date: no task carries a "
            "three-point\n  estimate, so the simulation has no uncertainty to "
            "model and collapsed\n  onto the deterministic CPM finish."
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="trueppm-scheduler",
        description="TruePPM scheduling engine — CPM and Monte Carlo",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # schedule subcommand
    p_sched = sub.add_parser("schedule", help="Run CPM on a project JSON file")
    p_sched.add_argument("project", help="Path to project JSON file")
    p_sched.add_argument("--json", action="store_true", help="Output as JSON")
    p_sched.set_defaults(func=_cmd_schedule)

    # monte-carlo subcommand
    p_mc = sub.add_parser("monte-carlo", help="Run Monte Carlo simulation")
    p_mc.add_argument("project", help="Path to project JSON file")
    p_mc.add_argument(
        "--runs", type=int, default=10_000, help="Number of simulations (default: 10000)"
    )
    p_mc.add_argument("--seed", type=int, default=None, help="RNG seed for reproducibility")
    p_mc.add_argument("--json", action="store_true", help="Output as JSON")
    p_mc.add_argument(
        "--distribution", action="store_true", help="Include full distribution in JSON output"
    )
    p_mc.set_defaults(func=_cmd_monte_carlo)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
