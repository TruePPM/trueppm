"""Add the tombstone-reap clock ``deleted_at`` to ProjectMembership (#2342).

The nightly ``reap_domain_tombstones`` measures a tombstone's age from this column.
Rows already tombstoned have no record of when they were deleted, so the backfill
stamps them with the migration's own time: each gets one full
``TRUEPPM_TOMBSTONE_RETENTION_DAYS`` window from the upgrade, never less than an
offline client was promised. Leaving them NULL would mean never reaping them, the
unbounded growth this column exists to end. ``deleted_at`` is never serialized, so
the backfill draws no ``sync_seq``.

The column is nullable with no default, so an old pod still serving during a rolling
deploy inserts and soft-deletes without naming it. A tombstone such a pod writes after
this migration gets a NULL clock and is not reaped, which errs toward keeping it.
"""

from typing import Any

from django.db import migrations, models
from django.utils import timezone


def backfill_deleted_at(apps: Any, schema_editor: Any) -> None:
    now = timezone.now()
    for model_name in ("ProjectMembership",):
        model = apps.get_model("access", model_name)
        model.objects.filter(is_deleted=True, deleted_at__isnull=True).update(deleted_at=now)


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0021_sync_seq_keyset_indexes"),
    ]

    operations = [
        migrations.AddField(
            model_name="projectmembership",
            name="deleted_at",
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.RunPython(backfill_deleted_at, migrations.RunPython.noop),
    ]
