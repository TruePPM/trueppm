"""A database recorded as applied through ``access`` 0012 upgrades via the squash.

Round 2 of #4320's completeness audit found that the access app's 0.4 squash
(``0013_squashed_0019_release_0_4``) is in no released tag — ``v0.3.0-alpha.3``
stops at ``access`` 0012 — so a real 0.3→0.4 upgrade never applies the retained
originals 0013-0019 at all. Django's squash-application semantics route that
database straight to the squash itself: unlike ``notifications`` 0003 (see
``tests/apps/notifications/test_matrix_cleanup_upgrade.py``, where a partially
applied squash range falls back to the unsquashed originals), a database with
*none* of ``access`` 0013-0019 applied has its migration graph collapse those
nodes into the squash node, and the squash — not any original — is what runs.

That makes the ``viewer_zero_to_one`` restoration genuinely load-bearing here,
not merely fresh-install self-containment: every Viewer on a 0.3→0.4 upgrade
keeps ordinal 0 unless the squash itself carries that RunPython step. This test
proves both halves: (a) the migration plan for a database at the real 0.3
boundary uses the squash, not the originals, and (b) the squash the plan would
run still carries ``viewer_zero_to_one``.

Like ``test_matrix_cleanup_upgrade.py``, this walks Django's own migration
loader/executor and never imports a migration module by name (CLAUDE.md
migration rule 3). The squash's data-op *set* (independent of this upgrade
scenario) is covered by ``tests/test_squash_data_op_parity.py``; the ordinal
move's own guard logic by ``tests/apps/access/test_role_ordinals.py``.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.operations import RunPython
from django.db.migrations.recorder import MigrationRecorder

# The real v0.3.0-alpha.3 boundary: every access migration up to and including
# 0012, however a given database happens to have it recorded (as the individual
# originals, or already consolidated into the first squash).
_ACCESS_AT_0012 = {
    "0001_initial",
    "0001_squashed_0012_programmembership_role_title",
    "0002_alter_projectmembership_id",
    "0003_projectmembership_soft_delete",
    "0004_alter_projectmembership_role",
    "0005_program_entity_and_membership",
    "0006_role_ordinal_spacing",
    "0007_projectmembership_joined_at_and_more",
    "0008_projectmembership_source_group",
    "0009_projectmembership_pm_proj_serverver_idx",
    "0010_programmembership_joined_at_and_more",
    "0011_alter_programmembership_unique_together_and_more",
    "0012_programmembership_role_title",
}
_SQUASH = ("access", "0013_squashed_0019_release_0_4")
_RETAINED_ORIGINALS = [
    ("access", "0013_userdefinedmentiongroup"),
    ("access", "0014_programmembership_progm_serverver_idx"),
    ("access", "0015_programuserdefinedmentiongroup"),
    ("access", "0016_externalstakeholder"),
    ("access", "0017_viewer_ordinal_one"),
    ("access", "0018_programmembership_sync_seq_and_more"),
    ("access", "0019_programmembership_reinstated_at_and_more"),
]


@pytest.mark.django_db
def test_database_at_access_0012_is_planned_to_run_the_squash_not_the_originals() -> None:
    recorded = MigrationRecorder(connection).applied_migrations()
    # Everything outside access stays applied; inside it, stop at 0012 — none of
    # the migrations the 0.4 squash replaces have ever run on this database.
    at_0012 = {
        key: record
        for key, record in recorded.items()
        if key[0] != "access" or key[1] in _ACCESS_AT_0012
    }

    with patch.object(MigrationRecorder, "applied_migrations", return_value=at_0012):
        executor = MigrationExecutor(connection)
        plan = executor.migration_plan(executor.loader.graph.leaf_nodes())

    forward = {(mig.app_label, mig.name) for mig, backwards in plan if not backwards}
    assert _SQUASH in forward, "a DB at access 0012 is not planned to run the 0.4 squash"
    for original in _RETAINED_ORIGINALS:
        assert original not in forward, (
            "a DB at access 0012 should be served by the squash, not the retained "
            f"original {original} — Django's squash semantics say otherwise here"
        )

    squash = executor.loader.disk_migrations[_SQUASH]
    assert any(
        isinstance(op, RunPython) and op.code.__qualname__ == "viewer_zero_to_one"
        for op in squash.operations
    ), "the access 0.4 squash no longer carries the viewer_zero_to_one RunPython"
