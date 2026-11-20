"""Unit tests for the .test_durations coverage ratchet (#5084)."""

from __future__ import annotations

import json
from pathlib import Path

from tests._durations_coverage import check_durations_coverage, missing_share


def _write(path: Path, ids: list[str]) -> Path:
    path.write_text(json.dumps({i: 1.0 for i in ids}))
    return path


def test_fully_covered_passes(tmp_path: Path) -> None:
    ids = [f"t::{n}" for n in range(10)]
    assert check_durations_coverage(ids, _write(tmp_path / "d", ids)) is None


def test_at_threshold_passes(tmp_path: Path) -> None:
    ids = [f"t::{n}" for n in range(10)]
    assert check_durations_coverage(ids, _write(tmp_path / "d", ids[:8])) is None


def test_over_threshold_fails_with_fix_named(tmp_path: Path) -> None:
    ids = [f"t::{n}" for n in range(10)]
    msg = check_durations_coverage(ids, _write(tmp_path / "d", ids[:7]))
    assert msg is not None
    assert "3/10" in msg and "api:test-durations" in msg


def test_missing_file_counts_everything_missing(tmp_path: Path) -> None:
    assert missing_share(["a", "b"], tmp_path / "absent") == (2, 2)
    assert check_durations_coverage(["a", "b"], tmp_path / "absent") is not None


def test_empty_and_corrupt_file(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.write_text("")
    assert check_durations_coverage(["a"], empty) is not None
    assert check_durations_coverage(["a"], _write(tmp_path / "d", [])) is not None


def test_no_collected_tests_passes(tmp_path: Path) -> None:
    assert check_durations_coverage([], tmp_path / "absent") is None
