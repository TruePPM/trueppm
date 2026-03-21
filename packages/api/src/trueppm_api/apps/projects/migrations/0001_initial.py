"""Initial migration — creates ltree extension and core project models."""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.db import migrations, models

import trueppm_api.fields


class Migration(migrations.Migration):
    initial = True

    dependencies: list[tuple[str, str]] = []

    operations = [
        # Enable PostgreSQL ltree extension before any model that uses LtreeField.
        migrations.RunSQL(
            sql="CREATE EXTENSION IF NOT EXISTS ltree;",
            reverse_sql="DROP EXTENSION IF EXISTS ltree;",
        ),
        migrations.CreateModel(
            name="Calendar",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("name", models.CharField(max_length=255)),
                (
                    "working_days",
                    models.SmallIntegerField(
                        default=31,
                        help_text=(
                            "Bitmask of working days: Mon=1, Tue=2, Wed=4, "
                            "Thu=8, Fri=16, Sat=32, Sun=64"
                        ),
                    ),
                ),
                ("hours_per_day", models.FloatField(default=8.0)),
                ("timezone", models.CharField(default="UTC", max_length=64)),
            ],
            options={"db_table": "projects_calendar"},
        ),
        migrations.CreateModel(
            name="CalendarException",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)),
                (
                    "calendar",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="exceptions",
                        to="projects.calendar",
                    ),
                ),
                ("exc_start", models.DateField()),
                ("exc_end", models.DateField()),
                ("description", models.CharField(blank=True, max_length=255)),
            ],
            options={"db_table": "projects_calendar_exception"},
        ),
        migrations.CreateModel(
            name="Project",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("name", models.CharField(max_length=255)),
                ("description", models.TextField(blank=True)),
                ("start_date", models.DateField()),
                (
                    "calendar",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="projects",
                        to="projects.calendar",
                    ),
                ),
            ],
            options={
                "db_table": "projects_project",
                "ordering": ["start_date", "name"],
            },
        ),
        migrations.CreateModel(
            name="Task",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="tasks",
                        to="projects.project",
                    ),
                ),
                ("name", models.CharField(max_length=512)),
                (
                    "wbs_path",
                    trueppm_api.fields.LtreeField(
                        blank=True,
                        null=True,
                        help_text="WBS hierarchy path in ltree format, e.g. '1.2.3'",
                    ),
                ),
                ("duration", models.IntegerField(default=1, help_text="Duration in working days")),
                ("percent_complete", models.FloatField(default=0.0)),
                ("notes", models.TextField(blank=True)),
                ("early_start", models.DateField(blank=True, null=True)),
                ("early_finish", models.DateField(blank=True, null=True)),
                ("late_start", models.DateField(blank=True, null=True)),
                ("late_finish", models.DateField(blank=True, null=True)),
                (
                    "total_float",
                    models.IntegerField(
                        blank=True, null=True, help_text="Total float in working days"
                    ),
                ),
                (
                    "free_float",
                    models.IntegerField(
                        blank=True, null=True, help_text="Free float in working days"
                    ),
                ),
                ("is_critical", models.BooleanField(blank=True, null=True)),
                ("optimistic_duration", models.IntegerField(blank=True, null=True)),
                ("most_likely_duration", models.IntegerField(blank=True, null=True)),
                ("pessimistic_duration", models.IntegerField(blank=True, null=True)),
            ],
            options={
                "db_table": "projects_task",
                "ordering": ["wbs_path", "name"],
            },
        ),
        migrations.AddIndex(
            model_name="task",
            index=models.Index(fields=["project"], name="projects_task_project_idx"),
        ),
        # GiST index on wbs_path for fast ltree subtree/ancestor queries.
        migrations.RunSQL(
            sql="CREATE INDEX projects_task_wbs_gist ON projects_task USING GIST (wbs_path);",
            reverse_sql="DROP INDEX IF EXISTS projects_task_wbs_gist;",
        ),
        migrations.CreateModel(
            name="Dependency",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)),
                (
                    "predecessor",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="successors",
                        to="projects.task",
                    ),
                ),
                (
                    "successor",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="predecessors",
                        to="projects.task",
                    ),
                ),
                (
                    "dep_type",
                    models.CharField(
                        choices=[
                            ("FS", "Finish-to-Start"),
                            ("SS", "Start-to-Start"),
                            ("FF", "Finish-to-Finish"),
                            ("SF", "Start-to-Finish"),
                        ],
                        default="FS",
                        max_length=2,
                    ),
                ),
                (
                    "lag",
                    models.IntegerField(
                        default=0,
                        help_text="Lag in calendar days (positive = delay, negative = lead)",
                    ),
                ),
            ],
            options={"db_table": "projects_dependency"},
        ),
        migrations.AddConstraint(
            model_name="dependency",
            constraint=models.UniqueConstraint(
                fields=["predecessor", "successor", "dep_type"],
                name="unique_dependency",
            ),
        ),
    ]
