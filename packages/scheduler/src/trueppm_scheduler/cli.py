"""Command-line interface for trueppm-scheduler."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from trueppm_scheduler.engine import monte_carlo, schedule
from trueppm_scheduler.models import Project


def _load_project(path: str) -> Project:
    try:
        text = Path(path).read_text()
    except OSError as e:
        print(f"error: cannot read {path!r}: {e}", file=sys.stderr)
        sys.exit(1)
    try:
        return Project.from_json(text)
    except (KeyError, ValueError) as e:
        print(f"error: invalid project file: {e}", file=sys.stderr)
        sys.exit(1)


def _cmd_schedule(args: argparse.Namespace) -> None:
    project = _load_project(args.project)
    try:
        result = schedule(project)
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(result.to_dict(), indent=2))
        return

    print(f"\nProject: {project.name}")
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
            f"{task.id:<20} {task.name:<30} "
            f"{task.early_start!s:<12} {task.early_finish!s:<12} "
            f"{task.late_start!s:<12} {task.late_finish!s:<12} "
            f"{tf:>4}{cp}"
        )
    print(f"\nCritical path: {' → '.join(result.critical_path)}")


def _cmd_monte_carlo(args: argparse.Namespace) -> None:
    project = _load_project(args.project)
    try:
        # The library no longer caps runs/tasks by default; a local CLI run wants
        # no cap, so we leave max_runs/max_tasks at their default of None.
        result = monte_carlo(project, runs=args.runs, seed=args.seed)
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        out = result.to_dict()
        if not args.distribution:
            del out["distribution"]
        print(json.dumps(out, indent=2))
        return

    print(f"\nMonte Carlo — {result.runs:,} runs  ({project.name})\n")
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
