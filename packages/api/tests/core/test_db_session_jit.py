"""PostgreSQL JIT is off on every connection the application opens (#3829).

With JIT on, the task list's page query spent ~4.4 s compiling and ~50 ms executing
once a project reached ~2,000 tasks. These tests pin the three properties the fix
depends on: the setting is applied to real connections, it is session-scoped (so a
rolled-back request transaction cannot silently re-enable it), and the receiver never
issues PostgreSQL-only SQL on another backend.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.db import connection, transaction

from trueppm_api.core.db_session import disable_jit


def _show_jit() -> str:
    with connection.cursor() as cursor:
        cursor.execute("SHOW jit")
        row = cursor.fetchone()
    assert row is not None
    return str(row[0])


@pytest.mark.django_db
def test_application_connection_has_jit_off() -> None:
    assert _show_jit() == "off"


@pytest.mark.django_db(transaction=True)
def test_jit_stays_off_on_a_fresh_connection_after_a_rolled_back_transaction() -> None:
    # Reconnecting inside atomic() is the ATOMIC_REQUESTS shape: the connection is
    # opened by the request's own transaction. A SET issued inside that transaction
    # would be undone by the rollback below.
    connection.close()

    class _Rollback(Exception):
        pass

    with pytest.raises(_Rollback), transaction.atomic():
        assert _show_jit() == "off"
        raise _Rollback

    assert _show_jit() == "off"


def test_receiver_ignores_non_postgresql_backends() -> None:
    class _NoCursorConnection:
        vendor = "sqlite"

        def cursor(self) -> Any:
            raise AssertionError("receiver must not issue SQL on a non-PostgreSQL backend")

    disable_jit(sender=None, connection=_NoCursorConnection())  # type: ignore[arg-type]
