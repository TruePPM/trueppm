"""Every squashed migration keeps the data operations of the migrations it replaces.

Django's squash optimizer drops ``elidable=True`` RunPython / RunSQL operations, so a
squash generated without ``--no-optimize`` silently loses data steps: the notifications
``_clean_matrix`` cleanup went missing from ``0001_squashed_0006`` this way. The check
covers the whole squash set, not one named squash, so a squash written tomorrow is
held to the same rule.

It walks Django's own ``MigrationLoader`` graph and compares callables by identity, so
it never imports a migration module by name (CLAUDE.md migration rule 3).

Limitation: this only compares the *set* of restored data ops against the *set* of
ops the replaced migrations carried — it does not check their relative order within
a squash. A squash that restores the right ops in the wrong order (the projects
0015/0019 bug fixed alongside this one) passes here and is only caught by an actual
fresh-DB ``migrate`` run, such as CI's testdb-dump / ``--create-db`` test runs. Treat
that as a different, complementary safety net, not a gap this test also closes.
"""

from __future__ import annotations

import re

from django.db.migrations.loader import MigrationLoader
from django.db.migrations.operations import RunPython, RunSQL
from django.db.migrations.operations.base import Operation

# (app, replaced migration, callable name) -> why the squash state cannot supply the
# op's input. Every entry must still be exercised by the sweep (checked below), so a
# stale waiver fails rather than rotting.
EXEMPT: dict[tuple[str, str, str], str] = {
    ("workspace", "0002_remove_workspace_fiscal_year_start_and_more", "_forward"): (
        "reads the free-text fiscal_year_start column, which the squashed history never "
        "creates (the 0001 squash goes straight to the month/day pair), so the op has no "
        "input in the squash state"
    ),
    (
        "projects",
        "0090_historicaltask_proj_histdate_index",
        "repair_invalid_concurrent_index_op.<locals>._forward",
    ): (
        "repairs an INVALID index left by an interrupted CONCURRENTLY build (#4357) — "
        "the squash's copy of this index build (see its own comment) is a plain, fully "
        "atomic CREATE INDEX that only ever runs on a fresh install, where an "
        "interrupted build rolls back entirely rather than leaving an INVALID index, so "
        "the repair has nothing to do there and is correctly absent"
    ),
}


def _data_identity(op: Operation) -> tuple[str, ...] | None:
    """Return a stable identity for a data operation, or None for schema operations.

    RunPython is identified by the function object's module and qualified name, which
    is the same object whether the squash imports it directly or resolves it from the
    retained original. ``RunPython.noop`` is a reverse-only placeholder and is skipped.
    """
    if isinstance(op, RunPython):
        code = op.code
        if code.__qualname__.endswith("noop"):
            return None
        return ("RunPython", code.__module__, code.__qualname__)
    if isinstance(op, RunSQL):
        # A squash runs inside one transaction, so a ``CREATE INDEX CONCURRENTLY`` original
        # (atomic = False) is squashed as a plain CREATE INDEX of the same name and columns
        # (projects 0090, see the squash's comment). Compare with CONCURRENTLY removed.
        return ("RunSQL", " ".join(re.sub(r"\bCONCURRENTLY\s+", "", str(op.sql)).split()))
    return None


def test_every_squash_keeps_the_data_ops_of_the_migrations_it_replaces() -> None:
    loader = MigrationLoader(None, ignore_no_migrations=True)
    squashes = [mig for mig in loader.disk_migrations.values() if mig.replaces]
    # Guard against the sweep silently seeing nothing after a loader change.
    assert len(squashes) >= 20

    problems: list[str] = []
    exempt_hit: set[tuple[str, str, str]] = set()
    checked = 0
    for squash in squashes:
        kept = {ident for op in squash.operations if (ident := _data_identity(op)) is not None}
        for app, name in squash.replaces:
            original = loader.disk_migrations[(app, name)]
            for op in original.operations:
                ident = _data_identity(op)
                if ident is None:
                    continue
                checked += 1
                if ident in kept:
                    continue
                key = (app, name, ident[-1])
                if key in EXEMPT:
                    exempt_hit.add(key)
                    continue
                problems.append(f"{app}.{squash.name} drops {app}.{name}: {ident[0]} {ident[-1]}")

    assert checked > 0
    assert not problems, "squash drops data operations:\n" + "\n".join(problems)
    stale = set(EXEMPT) - exempt_hit
    assert not stale, f"EXEMPT entries no longer match a dropped op: {sorted(stale)}"
