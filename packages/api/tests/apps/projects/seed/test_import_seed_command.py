"""Command-level tests for ``manage.py import_seed`` (issue #1365).

The importer internals are covered by ``test_importer.py``; this exercises only
the thin management-command wrapper around them: argument parsing, owner
resolution, and the mapping of loader failures (missing file, invalid JSON,
``SeedValidationError``) onto ``CommandError`` so the CLI fails cleanly with a
message instead of an uncaught traceback.
"""

from __future__ import annotations

import json
from io import StringIO
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError

from trueppm_api.apps.projects.models import Program
from trueppm_api.apps.projects.seed.samples import _SEEDS_DIR

from .test_importer import _seed  # reuse the proven two-project fixture

pytestmark = pytest.mark.django_db

User = get_user_model()


def _write_seed(tmp_path: Path, payload: dict[str, Any]) -> str:
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


def test_missing_file_raises_command_error(tmp_path: Path) -> None:
    """A non-existent path fails with a clean CommandError, not FileNotFoundError."""
    missing = str(tmp_path / "nope.json")
    with pytest.raises(CommandError, match="Seed file not found"):
        call_command("import_seed", missing)


def test_invalid_json_raises_command_error(tmp_path: Path) -> None:
    """A file that is not valid JSON fails with a clean CommandError."""
    path = tmp_path / "bad.json"
    path.write_text("{ not json ", encoding="utf-8")
    with pytest.raises(CommandError, match="not valid JSON"):
        call_command("import_seed", str(path))


def test_unknown_owner_username_raises(tmp_path: Path) -> None:
    """``--owner`` naming a user that does not exist fails before any import."""
    path = _write_seed(tmp_path, _seed())
    with pytest.raises(CommandError, match="No user with username"):
        call_command("import_seed", path, "--owner", "ghost")
    assert not Program.objects.filter(code="atlas").exists()


def test_no_superuser_and_no_owner_raises(tmp_path: Path) -> None:
    """With ``--owner`` omitted and no superuser to fall back to, resolution fails."""
    path = _write_seed(tmp_path, _seed())
    with pytest.raises(CommandError, match="No superuser"):
        call_command("import_seed", path)
    assert not Program.objects.filter(code="atlas").exists()


def test_owner_defaults_to_first_superuser(tmp_path: Path) -> None:
    """With no ``--owner``, the first superuser owns the imported program."""
    User.objects.create_superuser(username="root", password="pw")
    path = _write_seed(tmp_path, _seed())
    call_command("import_seed", path, "--create-users")
    assert Program.objects.filter(code="atlas", is_deleted=False).exists()


def test_explicit_owner_username_is_used(tmp_path: Path) -> None:
    """``--owner <username>`` resolves an explicit non-superuser owner."""
    User.objects.create_user(username="boss", password="pw")
    path = _write_seed(tmp_path, _seed())
    call_command("import_seed", path, "--owner", "boss", "--create-users")
    assert Program.objects.filter(code="atlas", is_deleted=False).exists()


def test_validation_error_becomes_command_error(tmp_path: Path) -> None:
    """A SeedValidationError from the loader surfaces as a CommandError; nothing is written.

    An assignee that references an account the seed never declares fails
    validation once ``--create-users`` is on (mirrors ``test_invalid_seed_writes_nothing``).
    """
    User.objects.create_superuser(username="root", password="pw")
    seed = _seed()
    seed["projects"][0]["tasks"][0]["assignee"] = "ghost"
    path = _write_seed(tmp_path, seed)
    with pytest.raises(CommandError):
        call_command("import_seed", path, "--create-users")
    assert not Program.objects.filter(code="atlas").exists()


# --- --check: the dry run (#2418) ------------------------------------------


def test_check_accepts_a_valid_file(tmp_path: Path) -> None:
    out = StringIO()
    call_command("import_seed", _write_seed(tmp_path, _seed()), "--check", stdout=out)
    assert "Valid. No problems found." in out.getvalue()


def test_check_writes_nothing(tmp_path: Path) -> None:
    """The entire point: answer "will this be accepted?" without committing to a
    wipe-then-recreate on the program slug (ADR-0109)."""
    before = Program.objects.count()
    call_command("import_seed", _write_seed(tmp_path, _seed()), "--check", stdout=StringIO())
    assert Program.objects.count() == before
    assert not Program.objects.filter(code="atlas").exists()


def test_check_exits_non_zero_on_an_invalid_file(tmp_path: Path) -> None:
    seed = _seed()
    seed["projects"][0]["tasks"][0]["assignee"] = "ghost"
    with pytest.raises(CommandError, match="Invalid seed document"):
        call_command("import_seed", _write_seed(tmp_path, seed), "--check", stdout=StringIO())


def test_check_prints_every_diagnostic(tmp_path: Path) -> None:
    seed = _seed()
    del seed["schema_version"]
    seed["projects"][0]["tasks"][0]["assignee"] = "ghost"
    out = StringIO()
    with pytest.raises(CommandError):
        call_command("import_seed", _write_seed(tmp_path, seed), "--check", stdout=out)
    printed = out.getvalue()
    assert "$.schema_version: required and missing" in printed
    assert "ghost" in printed


def test_check_echoes_the_program_slug_it_would_have_replaced(tmp_path: Path) -> None:
    out = StringIO()
    call_command("import_seed", _write_seed(tmp_path, _seed()), "--check", stdout=out)
    printed = out.getvalue()
    assert "atlas" in printed
    assert "2 project(s)" in printed


def test_check_needs_no_superuser(tmp_path: Path) -> None:
    """A self-hoster validating a file before the first real import has no owner
    to resolve, and a dry run never uses one."""
    assert not User.objects.filter(is_superuser=True).exists()
    call_command("import_seed", _write_seed(tmp_path, _seed()), "--check", stdout=StringIO())


@pytest.mark.parametrize("fixture_path", sorted(_SEEDS_DIR.glob("*.json")), ids=lambda p: p.name)
def test_every_committed_fixture_passes_check(fixture_path: Path) -> None:
    """A new bundled sample cannot be added without passing the validator.

    Asserted against the files on disk rather than a hard-coded list, so the
    guard extends to fixtures that do not exist yet.
    """
    call_command("import_seed", str(fixture_path), "--check", stdout=StringIO())
