"""Add per-program access-evidence timestamps to ProgramMembership (#878).

Mirrors migration 0007 for ProjectMembership so ADR-0070's "ProgramMembership
mirrors ProjectMembership exactly" claim holds.

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
        ("access", "0009_projectmembership_pm_proj_serverver_idx"),
    ]

    operations = [
        migrations.AddField(
            model_name="programmembership",
            name="joined_at",
            field=models.DateTimeField(default=django.utils.timezone.now, editable=False),
        ),
        migrations.AddField(
            model_name="programmembership",
            name="role_changed_at",
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
    ]
