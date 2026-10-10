"""Tests for ``migration_helpers.repair_invalid_concurrent_index`` (#4357).

``CREATE INDEX CONCURRENTLY`` does not roll back on failure: PostgreSQL leaves the
index present but marked ``INVALID``. We cannot reproduce the real-world trigger
(a `migrate_locked` pod dying mid-build) in a test, and flipping ``pg_index.indisvalid``
by hand needs superuser DDL on a system catalog that the test role may not have. So
these tests reproduce the *identical failure shape* PostgreSQL itself documents: a
``CREATE UNIQUE INDEX CONCURRENTLY`` build that hits a duplicate value fails partway
through and leaves the index ``INVALID`` — exactly the state a dead lock-holder leaves
behind. ``transaction=True`` is required because ``CREATE``/``DROP INDEX
CONCURRENTLY`` cannot run inside a transaction block, which is exactly what
pytest-django's default test wrapping provides.
"""

from __future__ import annotations

import pytest
from django.db import connection
from django.db.utils import Error as DjangoDbError

from trueppm_api.apps.projects.migration_helpers import repair_invalid_concurrent_index

_TABLE = "test_4357_concurrent_repair"
_INDEX = "test_4357_concurrent_repair_idx"


def _index_state(indexname: str) -> tuple[bool, bool]:
    """Return (exists, is_valid) for an index by name."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT i.indisvalid FROM pg_class c "
            "JOIN pg_index i ON i.indexrelid = c.oid "
            "WHERE c.relname = %s",
            [indexname],
        )
        row = cursor.fetchone()
    if row is None:
        return False, False
    return True, bool(row[0])


@pytest.fixture
def invalid_index() -> None:
    """A table with a duplicate ``val`` and an INVALID unique index built against it.

    The ``CREATE UNIQUE INDEX CONCURRENTLY`` build fails on the duplicate partway
    through, leaving ``_INDEX`` present but INVALID — the same state a dead
    `migrate_locked` lock-holder leaves behind mid-build.
    """
    with connection.cursor() as cursor:
        cursor.execute(f"DROP TABLE IF EXISTS {_TABLE} CASCADE;")
        cursor.execute(f"CREATE TABLE {_TABLE} (id serial PRIMARY KEY, val integer);")
        cursor.execute(f"INSERT INTO {_TABLE} (val) VALUES (1), (1);")
    with connection.cursor() as cursor, pytest.raises(DjangoDbError):
        cursor.execute(f"CREATE UNIQUE INDEX CONCURRENTLY {_INDEX} ON {_TABLE} (val);")
    exists, valid = _index_state(_INDEX)
    assert exists and not valid, "fixture setup did not reproduce an INVALID index"
    yield
    with connection.cursor() as cursor:
        cursor.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {_INDEX};")
        cursor.execute(f"DROP TABLE IF EXISTS {_TABLE} CASCADE;")


@pytest.mark.django_db(transaction=True)
def test_repair_drops_an_invalid_index(invalid_index: None) -> None:
    repair_invalid_concurrent_index(connection, _INDEX)

    exists, _valid = _index_state(_INDEX)
    assert not exists


@pytest.mark.django_db(transaction=True)
def test_rebuild_after_repair_produces_a_valid_index(invalid_index: None) -> None:
    """End to end: repair-then-rebuild (the sequence every patched migration now runs)
    recovers a healthy index even though the original build failed.
    """
    repair_invalid_concurrent_index(connection, _INDEX)

    with connection.cursor() as cursor:
        # Non-unique on purpose: the real migrations' builds are plain indexes, and the
        # duplicate row that broke the original unique build must not block this one.
        cursor.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {_INDEX} ON {_TABLE} (val);")

    exists, valid = _index_state(_INDEX)
    assert exists and valid


@pytest.mark.django_db(transaction=True)
def test_without_repair_a_rerun_silently_leaves_the_index_invalid(invalid_index: None) -> None:
    """Negative control — proves the bug #4357 describes, not just the fix.

    Simulates the unpatched migration: ``IF NOT EXISTS`` sees the INVALID index
    already present and skips rebuilding it, so the index stays broken forever with
    no error raised.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            f"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS {_INDEX} ON {_TABLE} (val);"
        )

    exists, valid = _index_state(_INDEX)
    assert exists and not valid


@pytest.mark.django_db(transaction=True)
def test_repair_is_a_noop_on_a_valid_index() -> None:
    try:
        with connection.cursor() as cursor:
            cursor.execute(f"DROP TABLE IF EXISTS {_TABLE} CASCADE;")
            cursor.execute(f"CREATE TABLE {_TABLE} (id serial PRIMARY KEY, val integer);")
            cursor.execute(f"CREATE INDEX CONCURRENTLY {_INDEX} ON {_TABLE} (val);")
            cursor.execute("SELECT oid FROM pg_class WHERE relname = %s", [_INDEX])
            oid_before = cursor.fetchone()[0]

        repair_invalid_concurrent_index(connection, _INDEX)

        with connection.cursor() as cursor:
            cursor.execute("SELECT oid FROM pg_class WHERE relname = %s", [_INDEX])
            row = cursor.fetchone()
        assert row is not None and row[0] == oid_before, "valid index was dropped/rebuilt"
        exists, valid = _index_state(_INDEX)
        assert exists and valid
    finally:
        with connection.cursor() as cursor:
            cursor.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {_INDEX};")
            cursor.execute(f"DROP TABLE IF EXISTS {_TABLE} CASCADE;")


@pytest.mark.django_db(transaction=True)
def test_repair_is_a_noop_on_a_missing_index() -> None:
    repair_invalid_concurrent_index(connection, "definitely_not_a_real_index_4357")
