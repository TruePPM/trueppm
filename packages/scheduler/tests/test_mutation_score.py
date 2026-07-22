"""Tests for the mutation-score helper (scripts/check_mutation_score.py).

The helper lives in ``scripts/`` (a dev-only tool, never shipped in the wheel),
so it is imported here by file path. mutmut copies ``scripts/`` into its
``mutants/`` sandbox (``also_copy`` in pyproject) so this same import resolves
when the suite runs under mutation.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "check_mutation_score.py"
_spec = importlib.util.spec_from_file_location("check_mutation_score", _SCRIPT)
assert _spec is not None and _spec.loader is not None
cms = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cms)


class TestComputeScore:
    def test_all_killed_is_one(self) -> None:
        assert cms.compute_score({"killed": 10, "survived": 0}) == pytest.approx(1.0)

    def test_all_survived_is_zero(self) -> None:
        assert cms.compute_score({"killed": 0, "survived": 10}) == pytest.approx(0.0)

    def test_half_killed(self) -> None:
        assert cms.compute_score({"killed": 5, "survived": 5}) == pytest.approx(0.5)

    def test_timeout_counts_as_killed(self) -> None:
        # A mutant that hangs is caught by the per-mutant timeout → detected.
        assert cms.compute_score({"killed": 4, "timeout": 1, "survived": 5}) == pytest.approx(0.5)

    def test_no_tests_and_skipped_are_excluded_from_denominator(self) -> None:
        # 5 killed / 5 considered = 1.0 — the 90 uncovered mutants are a coverage
        # gap, not an assertion gap, so they must not drag the score down.
        stats = {"killed": 5, "survived": 0, "no_tests": 80, "skipped": 10}
        assert cms.compute_score(stats) == pytest.approx(1.0)

    def test_suspicious_and_segfault_are_not_detected(self) -> None:
        # Conservative: ambiguous outcomes count against the score.
        stats = {"killed": 2, "survived": 0, "suspicious": 1, "segfault": 1}
        assert cms.compute_score(stats) == pytest.approx(0.5)

    def test_empty_run_returns_none(self) -> None:
        assert cms.compute_score({"no_tests": 3, "skipped": 1}) is None

    def test_matches_real_smoke_run_shape(self) -> None:
        # The shape captured from a real `mutmut export-cicd-stats` on cli.py.
        stats = {
            "killed": 109,
            "survived": 107,
            "total": 216,
            "no_tests": 0,
            "skipped": 0,
            "suspicious": 0,
            "timeout": 0,
            "check_was_interrupted_by_user": 0,
            "segfault": 0,
        }
        assert cms.compute_score(stats) == pytest.approx(109 / 216)


class TestMainGate:
    def _write(self, tmp_path: Path, stats: dict[str, int]) -> Path:
        p = tmp_path / "stats.json"
        p.write_text(json.dumps(stats), "utf-8")
        return p

    def test_report_only_passes_even_when_low(self, tmp_path: Path) -> None:
        stats_path = self._write(tmp_path, {"killed": 1, "survived": 99})
        assert cms.main([str(stats_path), "--min", "0"]) == 0

    def test_gate_fails_below_floor(self, tmp_path: Path) -> None:
        stats_path = self._write(tmp_path, {"killed": 1, "survived": 99})
        assert cms.main([str(stats_path), "--min", "0.5"]) == 1

    def test_gate_passes_at_or_above_floor(self, tmp_path: Path) -> None:
        stats_path = self._write(tmp_path, {"killed": 80, "survived": 20})
        assert cms.main([str(stats_path), "--min", "0.8"]) == 0

    def test_missing_file_returns_error_code(self, tmp_path: Path) -> None:
        assert cms.main([str(tmp_path / "nope.json"), "--min", "0.5"]) == 2

    def test_empty_run_is_not_gated(self, tmp_path: Path) -> None:
        stats_path = self._write(tmp_path, {"no_tests": 5, "skipped": 1})
        assert cms.main([str(stats_path), "--min", "0.9"]) == 0
