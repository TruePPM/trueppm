"""Add short_id to Task and Risk, object_sequence to Project (ADR-0016)."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0013_task_planned_start"),
    ]

    operations = [
        # Project.object_sequence — per-project sequential counter shared by
        # Tasks and Risks for short_id generation.
        migrations.AddField(
            model_name="project",
            name="object_sequence",
            field=models.BigIntegerField(default=0, editable=False),
        ),
        migrations.AddField(
            model_name="historicalproject",
            name="object_sequence",
            field=models.BigIntegerField(default=0, editable=False),
        ),
        # Task.short_id
        migrations.AddField(
            model_name="task",
            name="short_id",
            field=models.CharField(blank=True, max_length=8, editable=False),
        ),
        migrations.AddField(
            model_name="historicaltask",
            name="short_id",
            field=models.CharField(blank=True, max_length=8, editable=False),
        ),
        # Risk.short_id
        migrations.AddField(
            model_name="risk",
            name="short_id",
            field=models.CharField(blank=True, max_length=8, editable=False),
        ),
        migrations.AddField(
            model_name="historicalrisk",
            name="short_id",
            field=models.CharField(blank=True, max_length=8, editable=False),
        ),
        # Unique constraints: (project, short_id) on both Task and Risk.
        migrations.AddConstraint(
            model_name="task",
            constraint=models.UniqueConstraint(
                fields=["project", "short_id"],
                name="unique_task_short_id_per_project",
            ),
        ),
        migrations.AddConstraint(
            model_name="risk",
            constraint=models.UniqueConstraint(
                fields=["project", "short_id"],
                name="unique_risk_short_id_per_project",
            ),
        ),
    ]
