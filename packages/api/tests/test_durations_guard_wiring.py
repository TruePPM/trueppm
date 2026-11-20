"""Subprocess tests for the .test_durations guard hook wiring (#5084).

Run pytest in a scratch rootdir that loads only the guard hooks, so the shard
invocation shape (xdist ``-n``, ``--splits``, ``--group``) is exercised without
a database.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

API_ROOT = Path(__file__).resolve().parent.parent
CONFTEST = API_ROOT / "conftest.py"


def _scratch(tmp_path: Path, n_tests: int = 10) -> Path:
    root = tmp_path / "proj"
    (root / "tests").mkdir(parents=True)
    body = "\n".join(f"def test_{i}():\n    pass\n" for i in range(n_tests))
    (root / "tests" / "test_sample.py").write_text(body)
    (root / "pytest.ini").write_text("[pytest]\n")
    src = CONFTEST.read_text()
    start = src.index('_GUARD_KEY = "durations_guard"')
    (root / "conftest.py").write_text(
        f"import sys\nimport pytest\nsys.path.insert(0, {str(API_ROOT)!r})\n" + src[start:]
    )
    return root


def _durations(tmp_path: Path, ids: list[str]) -> Path:
    path = tmp_path / "durations.json"
    path.write_text(json.dumps({i: 1.0 for i in ids}))
    return path


def _run(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "no:cacheprovider",
            "-o",
            "addopts=",
            "--rootdir",
            ".",
            *args,
        ],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def _all_ids(n: int = 10) -> list[str]:
    return [f"tests/test_sample.py::test_{i}" for i in range(n)]


@pytest.mark.parametrize("extra", [[], ["-n", "2"]])
def test_missing_file_fails_cleanly_with_actionable_message(
    tmp_path: Path, extra: list[str]
) -> None:
    root = _scratch(tmp_path)
    proc = _run(
        root, *extra, "--splits", "2", "--group", "1", "--durations-path", str(tmp_path / "nope")
    )
    out = proc.stdout + proc.stderr
    assert proc.returncode == 4, out
    assert "INTERNALERROR" not in out
    assert len(re.findall("api:test-durations", out)) == 1


def test_complete_file_passes_under_xdist(tmp_path: Path) -> None:
    root = _scratch(tmp_path)
    proc = _run(
        root, "-n", "2", "--splits", "2", "--group", "1",
        "--durations-path", str(_durations(tmp_path, _all_ids())),
    )  # fmt: skip
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_inactive_without_splits(tmp_path: Path) -> None:
    root = _scratch(tmp_path)
    proc = _run(root, "-n", "2", "--durations-path", str(tmp_path / "nope"))
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_collect_only_reports_message(tmp_path: Path) -> None:
    root = _scratch(tmp_path)
    proc = _run(
        root, "--collect-only", "--splits", "2", "--group", "1",
        "--durations-path", str(tmp_path / "nope"),
    )  # fmt: skip
    assert proc.returncode == 4
    assert "api:test-durations" in proc.stdout + proc.stderr


def test_share_is_measured_on_full_set_not_the_group(tmp_path: Path) -> None:
    """2 of 10 missing is under the limit; make them all land in group 1."""
    root = _scratch(tmp_path)
    ids = _all_ids()
    # pytest-split puts unknown tests first in its algorithm's order; whichever
    # group they land in, the group-level share is far over 20% while the full
    # set's is exactly 20%.
    durations = _durations(tmp_path, ids[:8])
    for group in ("1", "2"):
        proc = _run(
            root, "-n", "2", "--splits", "2", "--group", group,
            "--durations-path", str(durations),
        )  # fmt: skip
        assert proc.returncode == 0, proc.stdout + proc.stderr
