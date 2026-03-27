"""Add Task.status field for the board/kanban view (issue #21, #58)."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0010_risk"),
    ]

    operations = [
        migrations.AddField(
            model_name="task",
            name="status",
            field=models.CharField(
                choices=[
                    ("NOT_STARTED", "Not started"),
                    ("IN_PROGRESS", "In progress"),
                    ("ON_HOLD", "On hold"),
                    ("COMPLETE", "Complete"),
                ],
                db_index=True,
                default="NOT_STARTED",
                max_length=12,
            ),
        ),
    ]
