"""Backfill the tombstone-retention floors added in ``0007`` / ``projects.0165`` (#2474).

Tombstones reaped before the floor existed never raised it, and during a rolling
update a worker on the previous image can still reap without raising it. Every
project floor and the program floor are therefore raised just above the current
sequence head, so every sync client re-syncs once after the upgrade. The reverse is
a no-op: the previous release never reads the floor.
"""

from typing import Any

from django.db import migrations


def _backfill(apps: Any, schema_editor: Any) -> None:
    from trueppm_api.apps.sync.sequence import backfill_tombstone_floors

    backfill_tombstone_floors(
        apps.get_model("projects", "Project"),
        apps.get_model("sync", "ProgramSyncSequence"),
    )


class Migration(migrations.Migration):
    dependencies = [
        ("sync", "0007_tombstone_floor"),
        ("projects", "0165_tombstone_floor"),
    ]

    operations = [
        migrations.RunPython(_backfill, migrations.RunPython.noop),
    ]
