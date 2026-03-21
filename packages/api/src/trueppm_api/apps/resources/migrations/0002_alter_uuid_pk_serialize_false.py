"""Add serialize=False to UUID primary key fields.

Django 5's migration autodetector expects primary_key=True UUIDs to also
carry serialize=False in the migration state. Without it, makemigrations
--check reports spurious "Alter field id" operations on every run.
No database schema change is made by these operations.
"""

from __future__ import annotations

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("resources", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="resource",
            name="id",
            field=models.UUIDField(
                default=uuid.uuid4, editable=False, primary_key=True, serialize=False
            ),
        ),
        migrations.AlterField(
            model_name="taskresource",
            name="id",
            field=models.UUIDField(
                default=uuid.uuid4, editable=False, primary_key=True, serialize=False
            ),
        ),
    ]
