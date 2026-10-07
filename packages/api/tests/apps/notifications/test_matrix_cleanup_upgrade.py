"""A database whose notifications state ends at 0003 is planned to run the 0004 matrix cleanup.

The 0004 data step strips unknown event-type / channel keys from persisted matrices.
Its squash, ``0001_squashed_0006``, dropped that step. A database that stops
at 0003 is not served by the squash at all: Django uses the retained originals for a
partially applied replacement range, so the cleanup has to be in the forward plan
that such a database gets.

This asserts that plan. It does not roll a real database back and forward: Django
cannot roll back into an applied squash range (the 0010 column survives the rollback),
and the forward re-run after a rollback did not re-apply 0004, so an executed round
trip proves nothing about the cleanup. The squash contents are guarded by
``tests/test_squash_data_op_parity.py``; the cleanup function itself by
``tests/apps/notifications/test_project_preferences.py``.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.operations import RunPython
from django.db.migrations.recorder import MigrationRecorder

from trueppm_api.apps.notifications.backfill import _clean_matrix

_NOTIFICATIONS_AT_0003 = {
    "0001_initial",
    "0002_project_notification_preference",
    "0003_projectnotificationpreference_paused",
}
_CLEANUP = ("notifications", "0004_clean_unknown_matrix_keys")


@pytest.mark.django_db
def test_database_at_0003_is_planned_to_run_the_matrix_cleanup() -> None:
    recorded = MigrationRecorder(connection).applied_migrations()
    # Everything outside notifications stays applied; inside it, stop at 0003.
    at_0003 = {
        key: record
        for key, record in recorded.items()
        if key[0] != "notifications" or key[1] in _NOTIFICATIONS_AT_0003
    }

    with patch.object(MigrationRecorder, "applied_migrations", return_value=at_0003):
        executor = MigrationExecutor(connection)
        plan = executor.migration_plan(executor.loader.graph.leaf_nodes())

    forward = {(mig.app_label, mig.name) for mig, backwards in plan if not backwards}
    assert _CLEANUP in forward, "a DB at notifications 0003 is not planned to run 0004"

    cleanup = executor.loader.disk_migrations[_CLEANUP]
    assert any(
        isinstance(op, RunPython) and op.code is _clean_matrix for op in cleanup.operations
    ), "0004 no longer runs the matrix cleanup"
