"""Session settings applied to every PostgreSQL connection the API or a worker opens.

**Why JIT is off (#3829).** PostgreSQL JIT-compiles any query whose *estimated* cost
crosses ``jit_above_cost`` (default 100,000), and also optimizes and inlines it past
``jit_optimize_above_cost`` / ``jit_inline_above_cost`` (500,000). The task list's
annotated page query crosses all three once planner statistics describe a ~2,000-task
project, and PostgreSQL then spends ~4.4 s compiling a query that executes in ~50 ms —
on every page the Schedule fetches, so opening that project took ~41 s. JIT pays off on
long analytic scans; every query this application issues is short and repeated, so the
compile cost is never recovered.

**Why a ``SET`` on connect rather than ``OPTIONS={"options": "-c jit=off"}``.** A startup
parameter is rejected outright by PgBouncer in transaction-pooling mode, which the
sizing guide recommends for large installs — that would turn a performance fix into a
connection failure. A ``SET`` cannot fail to connect. Behind a transaction pooler it is
best-effort (the setting lands on whichever server connection served it), so operators
running one are told to set it server-side as well.
"""

from __future__ import annotations

from typing import Any

from django.db.backends.base.base import BaseDatabaseWrapper


def disable_jit(sender: Any, connection: BaseDatabaseWrapper, **kwargs: Any) -> None:
    """``connection_created`` receiver: turn PostgreSQL JIT off for this session.

    Django sets autocommit before sending ``connection_created``, so the ``SET`` is
    session-scoped rather than confined to a transaction that ``ATOMIC_REQUESTS`` or a
    rollback would discard.
    """
    if connection.vendor != "postgresql":
        return
    with connection.cursor() as cursor:
        cursor.execute("SET jit = off")
