"""Add composite index on Task(project, early_start, early_finish) for utilization queries.

The resource utilization endpoint filters tasks by:
  WHERE project_id = X
    AND early_start <= window_end
    AND early_finish >= window_start

The existing single-column index on project_id alone forces a full scan of
all project tasks for the date range predicates. The composite index cuts this
to an index range scan — critical for projects with hundreds of tasks.
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0005_task_assignee"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="task",
            index=models.Index(
                fields=["project", "early_start", "early_finish"],
                name="task_utilization_window_idx",
            ),
        ),
    ]
