"""The ``UPPER(auth_user.email)`` functional index exists and the planner can use it (#3504).

Seven call sites resolve a person with ``User.objects.filter(email__iexact=...)``.
On PostgreSQL that compiles to ``UPPER("auth_user"."email"::text) = UPPER(%s)``,
so a plain btree on ``email`` would index the wrong thing and never be chosen —
the index has to be built on the same expression. Migration
``profiles.0009`` adds it.

Six of the seven are served by it. ``revoke_api_tokens`` matches ``username`` OR
``email`` in one query and still scans; that is stated in the migration and not
asserted here, because pinning a planner *choice* on a table this small is a
flaky test rather than a contract (the choice flips with row count).

These assert the *outcome* (an index on the live schema, and a plan that names
it) rather than importing the migration module, per CLAUDE.md migration rule 3:
a test coupled to a migration file name breaks when a squash deletes the file.

The second test is the one that would actually have caught the bug. Asserting
only that "an index on email exists" would pass for a plain ``db_index=True``
btree, which is precisely the thing that does not work here.
"""

from __future__ import annotations

import pytest
from django.contrib.auth.models import User
from django.db import connection

pytestmark = pytest.mark.django_db

_INDEX = "auth_user_email_upper_idx"


def _index_def(name: str) -> str | None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT indexdef FROM pg_indexes WHERE indexname = %s", [name])
        row = cursor.fetchone()
    return row[0] if row else None


def test_email_upper_index_exists_on_auth_user() -> None:
    ddl = _index_def(_INDEX)
    assert ddl is not None, f"{_INDEX} missing after migrate"
    assert "auth_user" in ddl
    # Functional, not a plain column index: the expression is what makes it usable.
    assert "upper" in ddl.lower()
    assert "email" in ddl


def test_planner_uses_the_index_for_a_real_iexact_lookup() -> None:
    """EXPLAIN the exact SQL the ORM emits and assert the plan names our index.

    ``enable_seqscan`` is disabled for this statement because the test database
    holds a handful of users, and on a table that small a sequential scan is
    genuinely cheaper — the planner would correctly ignore the index regardless
    of whether it matched. Turning seq scans off asks the narrower question this
    test is actually about: *can* the index serve this predicate at all? An
    index built on the wrong expression (a plain btree on ``email``) cannot, and
    the plan falls back to a seq scan even with the setting off.

    ``SET LOCAL`` scopes the change to the surrounding test transaction.
    """
    User.objects.create_user(username="idx-probe", email="Idx.Probe@Example.COM")

    sql, params = (
        User.objects.filter(email__iexact="idx.probe@example.com")
        .only("id")
        .query.sql_with_params()
    )

    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL enable_seqscan = off")
        cursor.execute(f"EXPLAIN {sql}", params)
        plan = "\n".join(row[0] for row in cursor.fetchall())

    assert _INDEX in plan, f"planner did not use {_INDEX}; plan was:\n{plan}"


def test_iexact_lookup_still_matches_case_insensitively() -> None:
    """The index is a pure performance addition — lookup semantics are unchanged."""
    user = User.objects.create_user(username="case-probe", email="Mixed.Case@Example.COM")

    assert User.objects.filter(email__iexact="mixed.case@example.com").first() == user
    assert User.objects.filter(email__iexact="MIXED.CASE@EXAMPLE.COM").first() == user
