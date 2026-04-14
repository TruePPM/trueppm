from __future__ import annotations

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0016_task_actual_dates"),
    ]

    operations = [
        migrations.CreateModel(
            name="BoardColumnConfig",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("columns", models.JSONField(default=list, help_text="Ordered list of {status, label, visible} objects.")),
                (
                    "project",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="board_column_config",
                        to="projects.project",
                    ),
                ),
            ],
            options={
                "verbose_name": "board column config",
                "verbose_name_plural": "board column configs",
            },
        ),
    ]
