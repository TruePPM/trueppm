"""Add job_role field to Resource."""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("resources", "0004_add_taskresource_resource_index"),
    ]

    operations = [
        migrations.AddField(
            model_name="resource",
            name="job_role",
            field=models.CharField(blank=True, default="", max_length=120),
            preserve_default=False,
        ),
    ]
