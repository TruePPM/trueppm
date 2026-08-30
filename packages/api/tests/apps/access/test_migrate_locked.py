"""The migration advisory lock actually serializes (#3188).

The chart runs `migrate` as a per-pod init container, so at replicaCount >= 2
every pod runs it concurrently against one database. These tests assert the
lock is real — held for the duration, released afterwards, and mutually
exclusive against a second holder — rather than that the command exits 0, which
it would do with the lock removed entirely.
"""

from __future__ import annotations

import threading
from unittest import mock

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, connections

from trueppm_api.apps.access.management.commands.migrate_locked import (
    MIGRATION_ADVISORY_LOCK_KEY,
)

pytestmark = pytest.mark.django_db


def _lock_is_held() -> bool:
    """True when any session holds our advisory lock on this database."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND "
            "((classid::bigint << 32) | objid::bigint) = %s",
            [MIGRATION_ADVISORY_LOCK_KEY],
        )
        row = cursor.fetchone()
        return bool(row and row[0])


def test_lock_is_held_during_migrate_and_released_after() -> None:
    observed: list[bool] = []

    def _observe(*args: object, **kwargs: object) -> None:
        observed.append(_lock_is_held())

    with mock.patch(
        "trueppm_api.apps.access.management.commands.migrate_locked.call_command",
        side_effect=_observe,
    ):
        call_command("migrate_locked")

    assert observed == [True], "the lock was not held while migrate ran"
    assert not _lock_is_held(), "the lock survived the command"


def test_a_second_holder_blocks_until_timeout() -> None:
    """The whole point: two concurrent runs must not both proceed.

    Uses a second real connection as the competing 'pod'. With the lock removed
    from the command this test fails — the command would migrate immediately
    instead of timing out.
    """
    other = connections.create_connection("default")
    try:
        with other.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_lock(%s)", [MIGRATION_ADVISORY_LOCK_KEY])

        migrate_ran = threading.Event()
        with (
            mock.patch(
                "trueppm_api.apps.access.management.commands.migrate_locked.call_command",
                side_effect=lambda *a, **k: migrate_ran.set(),
            ),
            pytest.raises(CommandError, match="Timed out"),
        ):
            call_command("migrate_locked", "--lock-timeout", "1")

        assert not migrate_ran.is_set(), (
            "migrate ran while another session held the lock — the lock is not serializing"
        )
    finally:
        with other.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_unlock(%s)", [MIGRATION_ADVISORY_LOCK_KEY])
        other.close()


def test_lock_is_released_when_migrate_raises() -> None:
    """A failed migration must not wedge the next rollout."""
    with (
        mock.patch(
            "trueppm_api.apps.access.management.commands.migrate_locked.call_command",
            side_effect=RuntimeError("boom"),
        ),
        pytest.raises(RuntimeError, match="boom"),
    ):
        call_command("migrate_locked")

    assert not _lock_is_held(), "a failed migrate left the advisory lock held"


def test_non_postgres_backend_skips_the_lock() -> None:
    """SQLite has no advisory locks; the command must still run migrate."""
    ran: list[bool] = []
    # `connection` is a ConnectionProxy; patch the wrapper the command resolves
    # through, not the proxy class, which has no `vendor` of its own.
    with (
        mock.patch.object(connections["default"], "vendor", "sqlite"),
        mock.patch(
            "trueppm_api.apps.access.management.commands.migrate_locked.call_command",
            side_effect=lambda *a, **k: ran.append(True),
        ),
    ):
        call_command("migrate_locked")
    assert ran == [True]
    assert not _lock_is_held(), "the non-PostgreSQL path must take no lock"
