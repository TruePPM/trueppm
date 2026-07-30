"""The one interpolated-SQL site in the API: atomic counter allocation (#2567).

Two counters are drawn the same way and must be: ``VersionedModel.server_version``
(a row's own save count, ADR-0142) and ``Project.last_sync_version`` (the allocator
for a project's ``sync_seq`` sequence, ADR-0686). Both need the *new* value in the
same statement that produces it::

    UPDATE <table> SET <col> = <col> + 1 WHERE <pk> = %s RETURNING <col>

The Django ORM cannot express that. ``QuerySet.update()`` returns a row count, not
values, and ``db_returning`` applies to INSERT only — so the alternative is
``update(**{col: F(col) + 1})`` followed by a separate ``SELECT``. That is two
statements, and outside an explicit transaction the re-read can observe a *different*
writer's allocation. For ``sync_seq`` that is #2491 — the delta permanently skipping
rows — reintroduced as a race; the single statement is also what takes and holds the
row write lock that ADR-0686 documents as load-bearing. So this module keeps the raw
SQL, and keeps it in exactly one place.

**Why one place.** Both call sites carried their own copy of the statement until
#2567. `sonar-project.properties` documents the pattern as a reviewed false positive
under a path-pinned `python:S2077` criterion, and when #2491 added the second copy in
a new file the glob did not follow it — a reviewed-safe pattern resurfaced as a
new-code Security finding. One helper means one criterion with nowhere to drift to.

**Why it is safe.** Nothing user-controlled reaches the statement. The interpolated
parts are *identifiers* read off the model ``_meta`` and passed through the backend's
own quoter (``connection.ops.quote_name``); the pk is bound as a parameter. Callers
name the field, not the column, so a caller cannot supply a column name at all.
"""

from __future__ import annotations

from typing import Any

from django.db import connections, models, router


def increment_returning(
    model: type[models.Model],
    field_name: str,
    pk: Any,
    *,
    instance: models.Model | None = None,
) -> int | None:
    """Atomically add 1 to one integer column and return its new value.

    Args:
        model: The concrete model owning the column.
        field_name: Model field name (not a column name) to increment.
        pk: Primary key of the row to increment.
        instance: Passed to the database router when the write target depends on
            the row itself; omit when the model alone decides.

    Returns:
        The post-increment value, or ``None`` when the ``UPDATE`` matched no row.
        A caller sees ``None`` when the pk vanished under it (a concurrent hard
        delete) or never existed — each decides what that means, so this function
        does not guess.
    """
    # Forward ``instance`` as a router hint only when there is one — a router that
    # reads ``hints["instance"]`` would trip over a present-but-None value.
    hints: dict[str, Any] = {} if instance is None else {"instance": instance}
    connection = connections[router.db_for_write(model, **hints)]
    quote = connection.ops.quote_name
    pk_field = model._meta.pk
    field = model._meta.get_field(field_name)
    # ``get_field`` also yields reverse relations, which have no column at all.
    # Callers name a concrete integer counter, so narrow the union rather than
    # letting a typo reach the SQL as ``None``.
    assert isinstance(field, models.Field)
    column_name = field.column
    # A concrete model always has a pk and real column names; narrow the stubs'
    # broadened ``str | None`` so the quoted identifiers are str.
    assert pk_field is not None and pk_field.column is not None
    assert column_name is not None
    table = quote(model._meta.db_table)
    column = quote(column_name)
    pk_col = quote(pk_field.column)
    with connection.cursor() as cursor:
        # nosemgrep: formatted-sql-query, sqlalchemy-execute-raw-query
        cursor.execute(
            f"UPDATE {table} SET {column} = {column} + 1 "  # nosec B608
            f"WHERE {pk_col} = %s RETURNING {column}",
            [pk],
        )
        row = cursor.fetchone()
    return int(row[0]) if row is not None else None
