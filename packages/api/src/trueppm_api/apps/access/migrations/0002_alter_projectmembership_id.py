"""Add serialize=False to ProjectMembership UUID primary key.

Django 5's migration autodetector expects primary_key=True UUIDs to also
carry serialize=False in the migration state. Without it, makemigrations
--check reports spurious "Alter field id" operations on every run.
No database schema change is made by this operation.
"""

from __future__ import annotations

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="projectmembership",
            name="id",
            field=models.UUIDField(
                default=uuid.uuid4, editable=False, primary_key=True, serialize=False
            ),
        ),
    ]
