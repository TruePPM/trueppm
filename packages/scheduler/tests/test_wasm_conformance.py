"""Conformance tests: verify the Python scheduler produces expected output for shared fixtures.

These same fixtures are loaded by the Rust WASM scheduler's conformance tests.
If the Python and Rust engines produce identical output for all fixtures, the
two implementations are in sync.

Run with: pytest packages/scheduler/tests/test_wasm_conformance.py -v
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from trueppm_scheduler import InvalidScheduleInput
from trueppm_scheduler.engine import schedule
from trueppm_scheduler.models import Project

FIXTURES_DIR = Path(__file__).resolve().parent.parent.parent / "wasm-scheduler" / "fixtures"
EXPECTED_DIR = FIXTURES_DIR / "expected"
INVALID_DIR = FIXTURES_DIR / "invalid"


def fixture_names() -> list[str]:
    """Discover all fixture JSON files (excluding the expected/ subdirectory)."""
    return sorted(p.stem for p in FIXTURES_DIR.glob("*.json"))


def invalid_fixture_names() -> list[str]:
    """Discover adversarial fixtures that both engines must reject."""
    if not INVALID_DIR.exists():
        return []
    return sorted(p.stem for p in INVALID_DIR.glob("*.json"))


def task_result_to_dict(task: object) -> dict:
    """Extract the CPM result fields from a scheduled Task."""
    return {
        "id": task.id,
        "early_start": task.early_start.isoformat(),
        "early_finish": task.early_finish.isoformat(),
        "late_start": task.late_start.isoformat(),
        "late_finish": task.late_finish.isoformat(),
        "total_float": task.total_float.total_seconds(),
        "free_float": task.free_float.total_seconds(),
        "is_critical": task.is_critical,
    }


@pytest.fixture(params=fixture_names(), ids=fixture_names())
def fixture_name(request: pytest.FixtureRequest) -> str:
    return request.param


def test_fixture_conformance(fixture_name: str) -> None:
    """Load a fixture, run the Python scheduler, and compare to expected output."""
    input_path = FIXTURES_DIR / f"{fixture_name}.json"
    expected_path = EXPECTED_DIR / f"{fixture_name}.json"

    with open(input_path) as f:
        input_data = json.load(f)

    project = Project.from_dict(input_data)
    result = schedule(project)

    actual = {
        "project_id": result.project_id,
        "project_start": result.project_start.isoformat(),
        "project_finish": result.project_finish.isoformat(),
        "tasks": [task_result_to_dict(t) for t in result.tasks],
        "critical_path": result.critical_path,
    }

    if expected_path.exists():
        with open(expected_path) as f:
            expected = json.load(f)

        assert actual["project_id"] == expected["project_id"]
        assert actual["project_start"] == expected["project_start"]
        assert actual["project_finish"] == expected["project_finish"]
        assert actual["critical_path"] == expected["critical_path"]

        for at, et in zip(actual["tasks"], expected["tasks"], strict=True):
            assert at["id"] == et["id"], "Task ID mismatch"
            assert at["early_start"] == et["early_start"], f"{at['id']}: early_start"
            assert at["early_finish"] == et["early_finish"], f"{at['id']}: early_finish"
            assert at["late_start"] == et["late_start"], f"{at['id']}: late_start"
            assert at["late_finish"] == et["late_finish"], f"{at['id']}: late_finish"
            assert at["is_critical"] == et["is_critical"], f"{at['id']}: is_critical"
    else:
        # Generate expected output for new fixtures
        EXPECTED_DIR.mkdir(exist_ok=True)
        with open(expected_path, "w") as f:
            json.dump(actual, f, indent=2)
            f.write("\n")
        pytest.skip(f"Generated expected output for {fixture_name}")


@pytest.mark.parametrize("invalid_name", invalid_fixture_names(), ids=invalid_fixture_names())
def test_invalid_fixture_rejected(invalid_name: str) -> None:
    """Adversarial fixtures must be rejected by both engines (#749).

    The Rust engine asserts the same set in
    ``packages/wasm-scheduler/tests/invalid_conformance.rs``. Each fixture
    parses cleanly but is structurally degenerate, so ``schedule()`` must raise
    ``InvalidScheduleInput`` rather than spin the calendar walk.
    """
    with open(INVALID_DIR / f"{invalid_name}.json") as f:
        data = json.load(f)
    project = Project.from_dict(data)
    with pytest.raises(InvalidScheduleInput):
        schedule(project)
