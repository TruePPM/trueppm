"""Add explicit is_milestone flag to Task (issue #55).

Milestone status is an explicit user/import-set flag — not inferred from
duration == 0. MS Project carries a separate <Milestone> element; Primavera P6
uses a task_type enum. Inference breaks round-trip fidelity and creates trust
issues in filtered calendar views visible to executives.

default=False means all existing tasks are non-milestones after migration —
correct, since no milestone data existed before this field.
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0006_task_utilization_index"),
    ]

    operations = [
        migrations.AddField(
            model_name="task",
            name="is_milestone",
            field=models.BooleanField(default=False),
        ),
    ]
