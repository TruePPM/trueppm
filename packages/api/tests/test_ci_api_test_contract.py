"""Static contract tests for the api:test CI job's database posture (#3389).

`api:test` is disk-bound, not query-bound. Four xdist workers each clone the
whole migrated schema with ``CREATE DATABASE ... TEMPLATE migrated``, every
``transaction=True`` test TRUNCATEs every table behind itself, and the session
ends by dropping all four clones again. That is why the *same* commit under the
*same* pytest-split ran 326s on one runner and 783s on another: the shard's wall
time tracks how contended the host's disk is, which no rebalancing can reach.

Two settings remove that cost, and both are easy to undo by accident because
neither has any visible effect on a passing pipeline:

  - the postgres service runs with durability off (the databases are throwaway
    and the container is destroyed with the job, so the WAL is never read);
  - ``--reuse-db`` skips ``teardown_databases()``, whose four DROP DATABASE
    statements were being charged by ``--durations`` to whichever test each
    worker happened to finish on — on the 783s job, two non-DB unit tests in
    ``test_valkey_sentinel.py`` at 92.95s and 67.92s.

The assertions below pin both, and pin the two boundaries that make them safe:
``--reuse-db`` must never reach local runs, and ``backup:restore-drill`` must
never inherit the durability tuning.
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

import pytest
import yaml

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CI_CONFIG = _REPO_ROOT / ".gitlab-ci.yml"
_API_PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"

# Every server setting whose absence would put the api:test workload back on the
# disk. Named individually rather than matched loosely so that removing one is a
# failure rather than a silently weaker guarantee.
_DURABILITY_OFF = ("fsync=off", "full_page_writes=off", "synchronous_commit=off")


@pytest.fixture(scope="module")
def ci_config() -> dict[str, Any]:
    loaded: dict[str, Any] = yaml.safe_load(_CI_CONFIG.read_text())
    return loaded


def _postgres_service(job: dict[str, Any]) -> dict[str, Any]:
    """The job's postgres service entry, by alias rather than by position."""
    for service in job["services"]:
        if service.get("alias") == "postgres":
            return dict(service)
    pytest.fail("job declares no postgres service")


# ---------------------------------------------------------------------------
# The .api template runs postgres without durability
# ---------------------------------------------------------------------------


def test_api_template_postgres_runs_without_durability(ci_config: dict[str, Any]) -> None:
    command = _postgres_service(ci_config[".api"]).get("command", [])

    assert command, (
        "the .api postgres service no longer overrides its command, so it runs "
        "the image default and every api:test shard is back on the disk"
    )
    assert command[0] == "postgres", "the command override must still start postgres itself"
    for setting in _DURABILITY_OFF:
        assert setting in command, f"the .api postgres service no longer sets {setting}"


def test_api_test_extends_the_tuned_template(ci_config: dict[str, Any]) -> None:
    """The tuning only reaches api:test through the template — it declares no services."""
    job = ci_config["api:test"]

    assert job["extends"] == ".api"
    assert "services" not in job, (
        "api:test now declares its own services, which overrides the template's "
        "postgres entirely and silently restores fsync"
    )


# ---------------------------------------------------------------------------
# ...and the restore drill does not
# ---------------------------------------------------------------------------


def test_restore_drill_keeps_durability_on(ci_config: dict[str, Any]) -> None:
    """A backup drill run against fsync=off is not evidence that a restore works.

    This is the one postgres service in the file that must stay slow. It is also
    the one most likely to be "fixed" by someone copying the tuned block across,
    because the drill is not fast either.
    """
    command = _postgres_service(ci_config["backup:restore-drill"]).get("command", [])

    for setting in _DURABILITY_OFF:
        assert setting not in command, (
            f"backup:restore-drill's postgres sets {setting} — the drill proves "
            "nothing about a real restore if the writes it restores are not durable"
        )


# ---------------------------------------------------------------------------
# --reuse-db is a CI-only flag
# ---------------------------------------------------------------------------


def test_api_test_skips_the_test_database_teardown(ci_config: dict[str, Any]) -> None:
    pytest_invocation = next(
        line for line in ci_config["api:test"]["script"] if line.startswith("python -m pytest")
    )

    assert "--reuse-db" in pytest_invocation, (
        "api:test no longer passes --reuse-db, so the session ends by dropping "
        "four schema clones the container is about to delete anyway"
    )


def test_reuse_db_never_reaches_a_local_run() -> None:
    """--reuse-db is safe only because CI has no next run to pollute.

    In a local checkout a persistent test database carries state forward, and the
    failures that produces name the files in the *current* diff while actually
    being residue from an earlier one — an expensive thing to debug. The flag
    belongs on the CI invocation and nowhere a bare `pytest` would pick it up.
    """
    pyproject = tomllib.loads(_API_PYPROJECT.read_text())
    addopts = pyproject["tool"]["pytest"]["ini_options"]["addopts"]

    assert "--reuse-db" not in addopts
    assert "--no-migrations" not in addopts, (
        "--no-migrations would skip the data backfills the migrated template "
        "exists to carry, and would do it on every local run"
    )
