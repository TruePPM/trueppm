"""Add per-project access-evidence timestamps to ProjectMembership (#590).

joined_at carries a ``default=timezone.now`` so this AddField backfills every
existing membership row with the migration-run timestamp — the best available
approximation, since VersionedModel never recorded a creation time. New rows
get their own insert-time value.

role_changed_at is nullable and is left NULL for existing rows: we have no
historical role-change record to recover, and NULL is the honest "no role
change since joining" signal the read serializer and UI key off.
"""

from __future__ import annotations

import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0006_role_ordinal_spacing"),
    ]

    operations = [
        migrations.AddField(
            model_name="projectmembership",
            name="joined_at",
            field=models.DateTimeField(default=django.utils.timezone.now, editable=False),
        ),
        migrations.AddField(
            model_name="projectmembership",
            name="role_changed_at",
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
    ]
