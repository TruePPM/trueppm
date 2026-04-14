"""Add explicit db_index on TaskResource.resource FK for aggregation query performance."""

from __future__ import annotations

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("resources", "0003_resource_soft_delete"),
    ]

    operations = [
        migrations.AlterField(
            model_name="taskresource",
            name="resource",
            field=models.ForeignKey(
                db_index=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="assignments",
                to="resources.resource",
            ),
        ),
    ]
