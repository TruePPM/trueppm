"""Tests for the trueppm-scheduler CLI (#784).

The CLI is the package's primary integration surface (it round-trips a project
JSON file through schedule/monte_carlo) but had zero coverage. These exercise
both subcommands in human and JSON modes plus the two _load_project failure
paths, driving main() through argparse so the wiring is covered end to end.
"""

from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

from trueppm_scheduler import Calendar, Dependency, Project, Task
from trueppm_scheduler.cli import _load_project, main


def _project_file(tmp_path: Path) -> str:
    """Write a small 3-task FS chain (one with a PERT spread) to a JSON file."""
    project = Project(
        id="p1",
        name="Demo Project",
        start_date=date(2026, 3, 2),  # Monday
        tasks=[
            Task(id="A", name="Design", duration=timedelta(days=5)),
            Task(
                id="B",
                name="Build",
                duration=timedelta(days=4),
                optimistic_duration=timedelta(days=2),
                most_likely_duration=timedelta(days=4),
                pessimistic_duration=timedelta(days=9),
            ),
            Task(id="C", name="Verify", duration=timedelta(days=2)),
        ],
        dependencies=[Dependency("A", "B"), Dependency("B", "C")],
        calendar=Calendar(),
    )
    path = tmp_path / "project.json"
    path.write_text(project.to_json())
    return str(path)


def _run(argv: list[str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["trueppm-scheduler", *argv])
    main()


def test_schedule_human_output(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(["schedule", _project_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    assert "Demo Project" in out
    # The FS chain is fully critical, so the critical path lists every task.
    assert "Critical path: A → B → C" in out


def test_schedule_json_output_is_valid_and_complete(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(["schedule", "--json", _project_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    data = json.loads(out)
    assert data["project_id"] == "p1"
    assert data["critical_path"] == ["A", "B", "C"]
    assert {t["id"] for t in data["tasks"]} == {"A", "B", "C"}


def test_monte_carlo_human_output(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(["monte-carlo", "--runs", "300", "--seed", "7", _project_file(tmp_path)], monkeypatch)
    out = capsys.readouterr().out
    assert "Monte Carlo" in out
    assert "P50" in out and "P95" in out


def test_monte_carlo_json_omits_distribution_by_default(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(
        ["monte-carlo", "--json", "--runs", "300", "--seed", "7", _project_file(tmp_path)],
        monkeypatch,
    )
    data = json.loads(capsys.readouterr().out)
    assert {"p50", "p80", "p95", "runs"} <= data.keys()
    # The full distribution is heavy; it is opt-in via --distribution.
    assert "distribution" not in data


def test_monte_carlo_json_includes_distribution_when_requested(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    _run(
        [
            "monte-carlo",
            "--json",
            "--distribution",
            "--runs",
            "300",
            "--seed",
            "7",
            _project_file(tmp_path),
        ],
        monkeypatch,
    )
    data = json.loads(capsys.readouterr().out)
    assert len(data["distribution"]) == 300


def test_monte_carlo_seed_is_reproducible(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    pf = _project_file(tmp_path)
    _run(["monte-carlo", "--json", "--runs", "300", "--seed", "7", pf], monkeypatch)
    first = json.loads(capsys.readouterr().out)
    _run(["monte-carlo", "--json", "--runs", "300", "--seed", "7", pf], monkeypatch)
    second = json.loads(capsys.readouterr().out)
    assert (first["p50"], first["p80"], first["p95"]) == (
        second["p50"],
        second["p80"],
        second["p95"],
    )


def test_load_project_missing_file_exits(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        _load_project("/no/such/project.json")
    assert exc.value.code == 1
    assert "cannot read" in capsys.readouterr().err


def test_load_project_invalid_json_exits(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("{ not valid json")
    with pytest.raises(SystemExit) as exc:
        _load_project(str(bad))
    assert exc.value.code == 1
    assert "invalid project file" in capsys.readouterr().err
