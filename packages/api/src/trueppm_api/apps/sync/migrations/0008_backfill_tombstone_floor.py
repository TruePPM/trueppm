"""Backfill the tombstone-retention floors added in ``0007`` / ``projects.0165`` (#2474).

Tombstones reaped before the floor existed never raised it, and during a rolling
update a worker on the previous image can still reap without raising it. Every
project floor and the program floor are therefore raised just above the current
sequence head, so every sync client re-syncs once after the upgrade. Monte Carlo
runs recorded at the old head move with it (the head doubles as the forecast plan
version), so a current forecast does not read ``project_changed``. The reverse is
a no-op: the previous release never reads the floor.
"""

from typing import Any

from django.db import migrations


def _backfill(apps: Any, schema_editor: Any) -> None:
    from django.db import transaction

    from trueppm_api.apps.sync.sequence import (
        backfill_tombstone_floors,
        bump_cached_forecast_plan_versions,
    )

    project = apps.get_model("projects", "Project")
    backfill_tombstone_floors(
        project,
        apps.get_model("sync", "ProgramSyncSequence"),
        apps.get_model("scheduling", "MonteCarloRun"),
    )
    # The cache is not transactional: touch it only once the bump has committed.
    transaction.on_commit(lambda: bump_cached_forecast_plan_versions(project))


class Migration(migrations.Migration):
    dependencies = [
        ("sync", "0007_tombstone_floor"),
        ("projects", "0165_tombstone_floor"),
        ("scheduling", "0016_montecarlorun_finish_readings"),
    ]

    operations = [
        migrations.RunPython(_backfill, migrations.RunPython.noop),
    ]
