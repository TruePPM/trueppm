# Generated for feat/risk-register (issue #52)

import uuid

import django.db.models.deletion
import simple_history.models
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0009_historicaldependency_historicalproject_and_more"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # -----------------------------------------------------------------------
        # Risk
        # -----------------------------------------------------------------------
        migrations.CreateModel(
            name="Risk",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                ("deleted_version", models.BigIntegerField(blank=True, editable=False, null=True)),
                ("title", models.CharField(max_length=512)),
                ("description", models.TextField(blank=True)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("OPEN", "Open"),
                            ("MITIGATING", "Mitigating"),
                            ("RESOLVED", "Resolved"),
                            ("ACCEPTED", "Accepted"),
                            ("CLOSED", "Closed"),
                        ],
                        db_index=True,
                        default="OPEN",
                        max_length=12,
                    ),
                ),
                ("probability", models.PositiveSmallIntegerField()),
                ("impact", models.PositiveSmallIntegerField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="risks",
                        to="projects.project",
                    ),
                ),
                (
                    "owner",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="owned_risks",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="created_risks",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "projects_risk",
                "ordering": ["-impact", "-probability", "title"],
            },
        ),
        migrations.AddIndex(
            model_name="risk",
            index=models.Index(fields=["project", "status"], name="risk_project_status_idx"),
        ),
        # -----------------------------------------------------------------------
        # RiskTask (through table)
        # -----------------------------------------------------------------------
        migrations.CreateModel(
            name="RiskTask",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                (
                    "risk",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        to="projects.risk",
                    ),
                ),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        to="projects.task",
                    ),
                ),
            ],
            options={
                "db_table": "projects_risk_task",
            },
        ),
        migrations.AlterUniqueTogether(
            name="risktask",
            unique_together={("risk", "task")},
        ),
        # tasks M2M — must come after RiskTask is created
        migrations.AddField(
            model_name="risk",
            name="tasks",
            field=models.ManyToManyField(
                blank=True,
                related_name="risks",
                through="projects.RiskTask",
                to="projects.task",
            ),
        ),
        # -----------------------------------------------------------------------
        # HistoricalRisk (django-simple-history audit table)
        # server_version and deleted_version are excluded via excluded_fields=_HISTORY_EXCLUDED_BASE
        # -----------------------------------------------------------------------
        migrations.CreateModel(
            name="HistoricalRisk",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False)),
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                ("title", models.CharField(max_length=512)),
                ("description", models.TextField(blank=True)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("OPEN", "Open"),
                            ("MITIGATING", "Mitigating"),
                            ("RESOLVED", "Resolved"),
                            ("ACCEPTED", "Accepted"),
                            ("CLOSED", "Closed"),
                        ],
                        db_index=True,
                        default="OPEN",
                        max_length=12,
                    ),
                ),
                ("probability", models.PositiveSmallIntegerField()),
                ("impact", models.PositiveSmallIntegerField()),
                ("created_at", models.DateTimeField(blank=True, editable=False)),
                ("updated_at", models.DateTimeField(blank=True, editable=False)),
                ("history_id", models.AutoField(primary_key=True, serialize=False)),
                ("history_date", models.DateTimeField(db_index=True)),
                ("history_change_reason", models.CharField(max_length=100, null=True)),
                (
                    "history_type",
                    models.CharField(
                        choices=[("+", "Created"), ("~", "Changed"), ("-", "Deleted")],
                        max_length=1,
                    ),
                ),
                (
                    "project",
                    models.ForeignKey(
                        blank=True,
                        db_constraint=False,
                        null=True,
                        on_delete=django.db.models.deletion.DO_NOTHING,
                        related_name="+",
                        to="projects.project",
                    ),
                ),
                (
                    "owner",
                    models.ForeignKey(
                        blank=True,
                        db_constraint=False,
                        null=True,
                        on_delete=django.db.models.deletion.DO_NOTHING,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        db_constraint=False,
                        null=True,
                        on_delete=django.db.models.deletion.DO_NOTHING,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "history_user",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "verbose_name": "historical risk",
                "verbose_name_plural": "historical risks",
                "ordering": ("-history_date", "-history_id"),
                "get_latest_by": ("history_date", "history_id"),
            },
            bases=(simple_history.models.HistoricalChanges, models.Model),
        ),
    ]
