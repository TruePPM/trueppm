"""Add soft-delete fields to all VersionedModel subclasses and promote
Dependency to VersionedModel.

- is_deleted / deleted_version added to Calendar, Project, Task
- Dependency gains server_version, is_deleted, deleted_version (joins VersionedModel)
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0003_rename_task_project_index"),
    ]

    operations = [
        # --- Calendar ---
        migrations.AddField(
            model_name="calendar",
            name="is_deleted",
            field=models.BooleanField(default=False, db_index=True),
        ),
        migrations.AddField(
            model_name="calendar",
            name="deleted_version",
            field=models.BigIntegerField(blank=True, editable=False, null=True),
        ),
        # --- Project ---
        migrations.AddField(
            model_name="project",
            name="is_deleted",
            field=models.BooleanField(default=False, db_index=True),
        ),
        migrations.AddField(
            model_name="project",
            name="deleted_version",
            field=models.BigIntegerField(blank=True, editable=False, null=True),
        ),
        # --- Task ---
        migrations.AddField(
            model_name="task",
            name="is_deleted",
            field=models.BooleanField(default=False, db_index=True),
        ),
        migrations.AddField(
            model_name="task",
            name="deleted_version",
            field=models.BigIntegerField(blank=True, editable=False, null=True),
        ),
        # --- Dependency: promote to VersionedModel ---
        # Add server_version, is_deleted, deleted_version.
        # The id column already exists and is unchanged.
        migrations.AddField(
            model_name="dependency",
            name="server_version",
            field=models.BigIntegerField(default=0, editable=False),
        ),
        migrations.AddField(
            model_name="dependency",
            name="is_deleted",
            field=models.BooleanField(default=False, db_index=True),
        ),
        migrations.AddField(
            model_name="dependency",
            name="deleted_version",
            field=models.BigIntegerField(blank=True, editable=False, null=True),
        ),
    ]
