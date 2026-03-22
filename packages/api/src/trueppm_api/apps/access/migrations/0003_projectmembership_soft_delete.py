"""Add soft-delete fields to ProjectMembership."""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0002_alter_projectmembership_id"),
    ]

    operations = [
        migrations.AddField(
            model_name="projectmembership",
            name="is_deleted",
            field=models.BooleanField(default=False, db_index=True),
        ),
        migrations.AddField(
            model_name="projectmembership",
            name="deleted_version",
            field=models.BigIntegerField(blank=True, editable=False, null=True),
        ),
    ]
