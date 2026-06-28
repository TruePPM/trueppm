"""Command-level tests for ``manage.py import_seed`` (issue #1365).

The importer internals are covered by ``test_importer.py``; this exercises only
the thin management-command wrapper around them: argument parsing, owner
resolution, and the mapping of loader failures (missing file, invalid JSON,
``SeedValidationError``) onto ``CommandError`` so the CLI fails cleanly with a
message instead of an uncaught traceback.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError

from trueppm_api.apps.projects.models import Program

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
