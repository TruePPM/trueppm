"""The conformance module's fixture guard, run outside the monorepo (#3856).

The published sdist ships ``tests/`` but not the sibling
``packages/wasm-scheduler/fixtures`` tree. These tests copy the module somewhere
that tree cannot be found and run pytest on it in a subprocess, pinning both
halves of the contract: without ``TRUEPPM_MONOREPO`` the module skips so the
rest of a downstream suite still runs, and with it the #1506 hard failure holds.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_MODULE = Path(__file__).resolve().parent / "test_wasm_conformance.py"


def _run_isolated(tmp_path: Path, *, monorepo: bool) -> subprocess.CompletedProcess[str]:
    # tmp_path/a/b/tests/ — FIXTURES_DIR resolves to tmp_path/a/wasm-scheduler/fixtures,
    # which never exists.
    tests_dir = tmp_path / "a" / "b" / "tests"
    tests_dir.mkdir(parents=True)
    shutil.copy(_MODULE, tests_dir / _MODULE.name)
    env = {k: v for k, v in os.environ.items() if k != "TRUEPPM_MONOREPO"}
    if monorepo:
        env["TRUEPPM_MONOREPO"] = "1"
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "-rs", str(tests_dir)],
        cwd=tests_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def test_missing_fixtures_skip_outside_the_monorepo(tmp_path: Path) -> None:
    result = _run_isolated(tmp_path, monorepo=False)
    assert result.returncode == pytest.ExitCode.NO_TESTS_COLLECTED, result.stdout
    assert "1 skipped" in result.stdout, result.stdout
    assert "TRUEPPM_MONOREPO=1" in result.stdout, result.stdout


def test_missing_fixtures_hard_fail_inside_the_monorepo(tmp_path: Path) -> None:
    result = _run_isolated(tmp_path, monorepo=True)
    assert result.returncode == pytest.ExitCode.INTERRUPTED, result.stdout
    assert "Conformance fixtures directory not found" in result.stdout, result.stdout
