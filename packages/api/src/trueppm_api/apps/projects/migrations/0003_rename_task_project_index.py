"""Rename auto-generated index on Task.project to match Django 5 naming convention.

Django 5 changed the auto-generated name format for Index(fields=["project"]) on
the Task model. The old name was projects_task_project_idx; Django 5 generates
projects_ta_project_71fd84_idx. RenameIndex performs a no-op rename in the migration
state and issues ALTER INDEX in PostgreSQL — safe and instantly reversible.
"""

from __future__ import annotations

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0002_alter_uuid_pk_serialize_false"),
    ]

    operations = [
        migrations.RenameIndex(
            model_name="task",
            new_name="projects_ta_project_71fd84_idx",
            old_name="projects_task_project_idx",
        ),
    ]
