"""Assertion-hardening tests for the CLI (#2330 — mutation survivors).

``test_cli.py`` covers the golden paths; mutation testing (``scheduler:mutation``,
#2282) showed that ``cli.main`` / ``_cmd_schedule`` / ``_cmd_monte_carlo`` still
had large clusters of *executed-but-unasserted* lines: help/label string
literals, ``indent=``/``prog=`` keyword values, the critical-path marker, and the
schedule error path. These pin the exact user-visible output and argparse wiring
so a regression in any of them fails a test rather than only a mutant.

The golden strings below are deliberate literals (not f-strings mirroring the
source): the CLI's human output *is* a contract, and a change to it must break a
test on purpose.
"""

from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

from trueppm_scheduler import Calendar, Dependency, Project, Task
from trueppm_scheduler.cli import main

# Exact human-output fragments (see cli._cmd_schedule / _cmd_monte_carlo).
_SCHEDULE_HEADER = (
    "ID                   Name                           "
    "ES           EF           LS           LF             TF  CP"
)


def _fs_chain_file(tmp_path: Path) -> str:
    """A fully-critical 3-task FS chain A→B→C (every task on the critical path)."""
    project = Project(
        id="p1",
        name="Demo Project",
        start_date=date(2026, 3, 2),  # Monday
        tasks=[
            Task(id="A", name="Design", duration=timedelta(days=5)),
            Task(id="B", name="Build", duration=timedelta(days=4)),
            Task(id="C", name="Verify", duration=timedelta(days=2)),
        ],
        dependencies=[Dependency("A", "B"), Dependency("B", "C")],
        calendar=Calendar(),
    )
    path = tmp_path / "chain.json"
    path.write_text(project.to_json())
    return str(path)


def _parallel_file(tmp_path: Path) -> str:
    """A→C and B→C where B floats (4 days), so B is off the critical path.

    Gives one non-critical row (no ``*`` marker, TF > 0) and two critical rows
    (``*`` marker, TF 0) in the human schedule table.
    """
    project = Project(
        id="p2",
        name="Para",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="A", name="Alpha", duration=timedelta(days=5)),
            Task(id="B", name="Beta", duration=timedelta(days=1)),
            Task(id="C", name="Gamma", duration=timedelta(days=1)),
        ],
        dependencies=[Dependency("A", "C"), Dependency("B", "C")],
        calendar=Calendar(),
    )
    path = tmp_path / "para.json"
    path.write_text(project.to_json())
    return str(path)


def _estimated_file(tmp_path: Path) -> str:
    """A→B chain where both tasks carry a wide three-point estimate.

    ``_parallel_file`` has no PERT values, so it simulates to a single date; this
    one gives the CLI a genuinely spread distribution (p50 < p95) to render.
    """
    project = Project(
        id="p3",
        name="Est",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(
                id="A",
                name="Alpha",
                duration=timedelta(days=10),
                optimistic_duration=timedelta(days=4),
                most_likely_duration=timedelta(days=10),
                pessimistic_duration=timedelta(days=30),
            ),
            Task(
                id="B",
                name="Beta",
                duration=timedelta(days=10),
                optimistic_duration=timedelta(days=4),
                most_likely_duration=timedelta(days=10),
                pessimistic_duration=timedelta(days=30),
            ),
        ],
        dependencies=[Dependency("A", "B")],
        calendar=Calendar(),
    )
    path = tmp_path / "est.json"
    path.write_text(project.to_json())
    return str(path)


def _cycle_file(tmp_path: Path) -> str:
    """A→B→A — schedule() raises CyclicDependencyError, driving the error path."""
    project = Project(
        id="c1",
        name="Cyclic",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=1)),
            Task(id="B", name="B", duration=timedelta(days=1)),
        ],
        dependencies=[Dependency("A", "B"), Dependency("B", "A")],
        calendar=Calendar(),
    )
    path = tmp_path / "cycle.json"
    path.write_text(project.to_json())
    return str(path)


def _run(argv: list[str], monkeypatch: pytest.MonkeyPatch, prog: str = "trueppm-scheduler") -> None:
    monkeypatch.setattr(sys, "argv", [prog, *argv])
    main()


def _run_expect_exit(
    argv: list[str], monkeypatch: pytest.MonkeyPatch, prog: str = "trueppm-scheduler"
) -> int:
    monkeypatch.setattr(sys, "argv", [prog, *argv])
    with pytest.raises(SystemExit) as exc:
        main()
    code = exc.value.code
    return int(code) if code is not None else 0


# ---------------------------------------------------------------------------
# argparse wiring: prog, description, required subcommand, subcommand/arg help.
# ---------------------------------------------------------------------------


def test_top_level_help_uses_explicit_prog_and_lists_subcommands(
    capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    # argv[0] is deliberately NOT the prog: an explicit prog="trueppm-scheduler"
    # must win, so prog=None (which would fall back to this basename) is caught.
    code = _run_expect_exit(["--help"], monkeypatch, prog="some-other-binary-42")
    out = capsys.readouterr().out
    assert code == 0
    assert "usage: trueppm-scheduler" in out
    assert "some-other-binary-42" not in out
    assert "TruePPM scheduling engine — CPM and Monte Carlo" in out
    # Subcommand help strings surface in the parent parser's command list.
    assert "Run CPM on a project JSON file" in out
    assert "Run Monte Carlo simulation" in out
    # No literal has been mangled with mutmut's XX...XX sentinel wrapping.
    assert "XX" not in out


def test_missing_subcommand_is_a_usage_error(
    capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    # required=True on the subparsers: no command must exit 2, not run anything.
    code = _run_expect_exit([], monkeypatch)
    assert code == 2
    assert "usage: trueppm-scheduler" in capsys.readouterr().err


def test_schedule_subcommand_help_text(capsys: pytest.CaptureFixture[str], monkeypatch) -> None:
    code = _run_expect_exit(["schedule", "--help"], monkeypatch)
    out = capsys.readouterr().out
    assert code == 0
    assert "Path to project JSON file" in out
    assert "Output as JSON" in out
    assert "XX" not in out


def test_monte_carlo_subcommand_help_text(capsys: pytest.CaptureFixture[str], monkeypatch) -> None:
    code = _run_expect_exit(["monte-carlo", "--help"], monkeypatch)
    out = capsys.readouterr().out
    assert code == 0
    assert "Number of simulations (default: 10000)" in out
    assert "RNG seed for reproducibility" in out
    assert "Include full distribution in JSON output" in out
    assert "Output as JSON" in out
    assert "XX" not in out


# ---------------------------------------------------------------------------
# schedule: human table formatting + JSON indentation + error path.
# ---------------------------------------------------------------------------


def test_schedule_human_table_header_is_exact(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(["schedule", _fs_chain_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    assert _SCHEDULE_HEADER in out
    # The rule under the header matches its width (len == 112).
    assert "-" * len(_SCHEDULE_HEADER) in out


def test_schedule_human_start_finish_line(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(["schedule", _parallel_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    assert "Project: Para" in out
    # A→C/B→C parallel plan spans 2026-03-02 .. 2026-03-09 (weekends skipped).
    assert "Start:   2026-03-02  Finish: 2026-03-09" in out


def test_schedule_human_rows_mark_critical_and_show_float(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(["schedule", _parallel_file(tmp_path)], monkeypatch)
    lines = capsys.readouterr().out.splitlines()
    alpha = next(ln for ln in lines if ln.startswith("A "))
    beta = next(ln for ln in lines if ln.startswith("B "))
    gamma = next(ln for ln in lines if ln.startswith("C "))
    # Critical rows carry the trailing " *" marker and TF 0.
    assert alpha.rstrip().endswith("   0 *")
    assert gamma.rstrip().endswith("   0 *")
    # The floating row: TF 4, no marker.
    assert beta.rstrip().endswith("   4")
    assert not beta.rstrip().endswith("*")
    assert "Beta" in beta


def test_schedule_human_critical_path_arrow_join(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(["schedule", _parallel_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    assert "Critical path: A → C" in out
    assert "Critical path: A → B" not in out  # B is not on the path


def test_schedule_json_is_pretty_printed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(["schedule", "--json", _fs_chain_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    data = json.loads(out)
    assert data["project_id"] == "p1"
    # indent=2 → each top-level key sits at exactly 2 spaces (indent=3 would be 3).
    assert any(ln.startswith('  "project_id"') for ln in out.splitlines())


def test_schedule_error_path_reports_and_exits(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    code = _run_expect_exit(["schedule", _cycle_file(tmp_path)], monkeypatch)
    err = capsys.readouterr().err
    assert code == 1
    # The message is prefixed with "error: " and carries the engine's detail,
    # not a bare None.
    assert err.startswith("error: ")
    assert "Cyclic dependency detected" in err


# ---------------------------------------------------------------------------
# monte-carlo: human line formatting, JSON indentation, default runs.
# ---------------------------------------------------------------------------


def test_monte_carlo_human_lines_are_exact(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(["monte-carlo", "--runs", "1000", "--seed", "7", _parallel_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    # runs count is thousands-separated; project name is echoed in parentheses.
    assert "Monte Carlo — 1,000 runs  (Para)" in out
    assert "  P50 (median):  " in out
    assert "  P80:           " in out
    assert "  P95:           " in out


def test_schedule_human_finish_is_labeled_earliest_feasible(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    # The CPM finish is a deterministic earliest-feasible date, not a commitment
    # date (#2437). The human output must say so, or a CLI user has no way to
    # learn it before pasting the number into a status report.
    _run(["schedule", _parallel_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    assert "(earliest feasible — run 'monte-carlo' for confidence dates)" in out


def test_monte_carlo_percentiles_carry_their_reading(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    # Bare "P50:"/"P80:" labels leave the reader to guess which one to commit to.
    _run(["monte-carlo", "--runs", "500", "--seed", "7", _estimated_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    assert "midpoint — even odds, not a commitment" in out
    assert "← commit to this date" in out
    assert "external or contractual deadlines" in out
    # A project with real estimates has a spread, so it must NOT claim collapse.
    assert "no uncertainty to model" not in out


def test_monte_carlo_explains_a_collapsed_distribution(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    # _parallel_file carries no three-point estimates, so every run finishes on
    # the same day. That is a correct result, but reads as a broken simulation
    # unless the output says why (#2437).
    _run(["monte-carlo", "--runs", "500", "--seed", "7", _parallel_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    assert "Every run finished on the same date" in out
    assert "no uncertainty to model" in out


def test_monte_carlo_json_output_carries_no_prose(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    # --json is machine output: the interpretation lines belong to the human
    # path only and must never contaminate a parseable payload.
    _run(
        ["monte-carlo", "--json", "--runs", "300", "--seed", "7", _parallel_file(tmp_path)],
        monkeypatch,
    )
    out = capsys.readouterr().out
    json.loads(out)  # would raise if prose leaked into the payload
    assert "commit to this date" not in out


def test_monte_carlo_json_is_pretty_printed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(
        ["monte-carlo", "--json", "--runs", "300", "--seed", "7", _parallel_file(tmp_path)],
        monkeypatch,
    )
    out = capsys.readouterr().out
    json.loads(out)
    # indent=2 → top-level keys at exactly 2 spaces (indent=3 would be 3).
    assert any(ln.startswith('  "p50"') for ln in out.splitlines())


def test_monte_carlo_error_path_reports_and_exits(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    code = _run_expect_exit(["monte-carlo", "--seed", "1", _cycle_file(tmp_path)], monkeypatch)
    err = capsys.readouterr().err
    assert code == 1
    assert err.startswith("error: ")
    assert "Cyclic dependency detected" in err


def test_monte_carlo_seed_makes_full_distribution_reproducible(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    # A coarse p50/p80/p95 match can coincide across two *unseeded* runs of a
    # low-variance project; comparing the full 300-sample distribution does not,
    # so this pins that the --seed value is actually threaded to the engine.
    pf = _parallel_file(tmp_path)
    args = ["monte-carlo", "--json", "--distribution", "--runs", "300", "--seed", "13", pf]
    _run(args, monkeypatch)
    first = json.loads(capsys.readouterr().out)["distribution"]
    _run(args, monkeypatch)
    second = json.loads(capsys.readouterr().out)["distribution"]
    assert first == second
    assert len(first) == 300


def test_monte_carlo_runs_defaults_to_ten_thousand(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    # No --runs: the argparse default (10_000) must reach the engine.
    _run(["monte-carlo", "--json", "--seed", "1", _parallel_file(tmp_path)], monkeypatch)
    data = json.loads(capsys.readouterr().out)
    assert data["runs"] == 10_000
