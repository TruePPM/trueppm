"""Conformance tests: verify the Python scheduler produces expected output for shared fixtures.

These same fixtures are loaded by the Rust WASM scheduler's conformance tests.
If the Python and Rust engines produce identical output for all fixtures, the
two implementations are in sync.

Run with: pytest packages/scheduler/tests/test_wasm_conformance.py -v
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from trueppm_scheduler import SchedulerError
from trueppm_scheduler.engine import monte_carlo, schedule
from trueppm_scheduler.models import Project

FIXTURES_DIR = Path(__file__).resolve().parent.parent.parent / "wasm-scheduler" / "fixtures"
EXPECTED_DIR = FIXTURES_DIR / "expected"
INVALID_DIR = FIXTURES_DIR / "invalid"

# Regeneration is an explicit, opt-in action — never a side effect of a normal
# run. A missing expected snapshot HARD-FAILS (#1506); it may only be
# (re)generated when REGEN_EXPECTED=1 is set. Before #1506 the missing-snapshot
# branch silently generated the file into the ephemeral CI workspace and skipped,
# so `wasm:conformance` passed green on every pipeline without ever comparing the
# two engines. Regenerate committed snapshots with, e.g.:
#   REGEN_EXPECTED=1 pytest packages/scheduler/tests/test_wasm_conformance.py
REGEN_EXPECTED = os.environ.get("REGEN_EXPECTED") == "1"

# Module-level hard guards (#1506). A path break — a standalone/PyPI-sdist run of
# the separable trueppm-scheduler package, or a directory rename — must fail
# loudly at import, not silently collect zero parametrized tests and pass green.
# fixture_names()/invalid_fixture_names() feed pytest params; without these an
# empty result yields an empty-but-green suite that never checks either engine.
assert FIXTURES_DIR.is_dir(), (
    f"Conformance fixtures directory not found: {FIXTURES_DIR}. The Python<->WASM "
    "conformance suite must run against the shared wasm-scheduler fixtures; a missing "
    "directory means zero tests would collect and the job would pass green (#1506)."
)
assert INVALID_DIR.is_dir(), (
    f"Invalid-fixture directory not found: {INVALID_DIR}. The reject-parity suite must "
    "run against fixtures/invalid/; a missing directory means the entire suite would "
    "vanish with a green run (#1506)."
)


def fixture_names() -> list[str]:
    """Discover all valid fixture JSON files (top-level only).

    ``glob("*.json")`` is deliberately non-recursive: it excludes the
    ``expected/``, ``invalid/``, and ``rust_rejects/`` subdirectories.
    """
    return sorted(p.stem for p in FIXTURES_DIR.glob("*.json"))


def invalid_fixture_names() -> list[str]:
    """Discover adversarial fixtures that both engines must reject."""
    return sorted(p.stem for p in INVALID_DIR.glob("*.json"))


# Collected once at import so the non-empty guards below run before pytest builds
# the parametrized suites. An empty directory (dir exists but holds no fixtures)
# would otherwise still collect zero tests and pass green (#1506).
_VALID_FIXTURES = fixture_names()
_INVALID_FIXTURES = invalid_fixture_names()
assert _VALID_FIXTURES, f"No *.json fixtures found in {FIXTURES_DIR} — zero tests would collect."
assert _INVALID_FIXTURES, (
    f"No *.json fixtures found in {INVALID_DIR} — the reject-parity suite would vanish."
)


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


@pytest.fixture(params=_VALID_FIXTURES, ids=_VALID_FIXTURES)
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

    if not expected_path.exists():
        if REGEN_EXPECTED:
            # Opt-in regeneration only. Writes the committed snapshot; the caller
            # inspects and commits it. Never reached on a normal (CI) run.
            EXPECTED_DIR.mkdir(exist_ok=True)
            with open(expected_path, "w") as f:
                json.dump(actual, f, indent=2)
                f.write("\n")
            pytest.skip(f"Regenerated expected snapshot for {fixture_name} (REGEN_EXPECTED=1).")
        # HARD FAIL (#1506): a missing snapshot must never soft-pass. Before this
        # the suite generated the file into the ephemeral CI workspace and skipped,
        # so the two engines were never compared and the job passed green forever.
        pytest.fail(
            f"Missing expected snapshot for fixture {fixture_name!r}: {expected_path}. "
            "A new fixture (or a regenerated-but-uncommitted snapshot) must not soft-pass "
            "the conformance suite. Regenerate with "
            "`REGEN_EXPECTED=1 pytest packages/scheduler/tests/test_wasm_conformance.py` "
            "and commit the expected/ output (#1506)."
        )

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
        # Assert float math too, so the hand-ported Rust float computation
        # (packages/wasm-scheduler/src/floats.rs) cannot drift from Python
        # undetected. Without these, ES/EF/LS/LF could match while total/free
        # float diverged across the two engines.
        assert at["total_float"] == et["total_float"], f"{at['id']}: total_float"
        assert at["free_float"] == et["free_float"], f"{at['id']}: free_float"
        assert at["is_critical"] == et["is_critical"], f"{at['id']}: is_critical"


@pytest.mark.parametrize("invalid_name", _INVALID_FIXTURES, ids=_INVALID_FIXTURES)
def test_invalid_fixture_rejected(invalid_name: str) -> None:
    """Adversarial fixtures must be rejected by both engines (#749).

    The Rust engine asserts the same set in
    ``packages/wasm-scheduler/tests/invalid_conformance.rs`` (which returns
    ``Err`` for each). Each fixture parses cleanly but is structurally degenerate,
    so the Python engine must raise rather than spin the calendar walk.

    The expected exception is :class:`SchedulerError` — the common parent of both
    :class:`InvalidScheduleInput` (degenerate calendar / duration / lag / graph)
    and :class:`CyclicDependencyError` (the ``cycle`` fixture, #1505). A cycle is
    a rejection just like the others; the cross-engine contract is "Python rejects
    this input, so Rust must too", which ``SchedulerError`` captures for both.
    """
    with open(INVALID_DIR / f"{invalid_name}.json") as f:
        data = json.load(f)
    project = Project.from_dict(data)
    with pytest.raises(SchedulerError):
        schedule(project)
    # Also assert the Monte Carlo entry point rejects every adversarial fixture.
    # Both public entry points share _validate_project, but monte_carlo() has its
    # own post-validation calendar walk (the working-day index build), so a fixture
    # that schedule() rejects could still have spun the MC path. This is exactly
    # how the blanket-exceptions OverflowError hid (#749): the invalid suite never
    # exercised monte_carlo(). max_tasks=None keeps the span fixture from tripping
    # the task-count cap before _validate_project can raise. SchedulerError (not
    # just InvalidScheduleInput) so the cycle fixture's CyclicDependencyError —
    # raised by monte_carlo's own cycle check — is also accepted (#1505).
    with pytest.raises(SchedulerError):
        monte_carlo(project, runs=10, max_runs=None, max_tasks=None)
