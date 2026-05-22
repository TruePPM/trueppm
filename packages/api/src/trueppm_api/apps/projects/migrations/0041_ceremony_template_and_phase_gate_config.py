"""Issue #528: CeremonyTemplate and PhaseGateConfig models (ADR-0079).

Migration safety:
- Two new tables (``projects_ceremony_template``, ``projects_phase_gate_config``)
  and two new HistoricalCeremonyTemplate snapshot tables for simple-history.
- No NOT NULL columns without defaults, no destructive ops, no data migration.
- PhaseGateConfig is created lazily by the view layer via get_or_create on
  first GET — existing programs receive a row on demand, not at migration time.
- CeremonyTemplate has a partial unique constraint on (program, name) WHERE
  is_deleted=False so soft-deleted tombstones don't block name reuse.
"""

import uuid

import django.db.models.deletion
import simple_history.models
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0040_program_general_fields"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="CeremonyTemplate",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                (
                    "deleted_version",
                    models.BigIntegerField(blank=True, editable=False, null=True),
                ),
                ("name", models.CharField(max_length=120)),
                (
                    "cadence_type",
                    models.CharField(
                        choices=[
                            ("weekly", "Weekly"),
                            ("biweekly", "Bi-weekly"),
                            ("monthly", "Monthly"),
                            ("on_milestone", "On milestone"),
                        ],
                        max_length=16,
                    ),
                ),
                ("cadence_day", models.CharField(blank=True, default="", max_length=32)),
                ("cadence_time", models.TimeField(blank=True, null=True)),
                ("duration_minutes", models.PositiveSmallIntegerField(default=60)),
                ("owner_role", models.CharField(blank=True, default="", max_length=64)),
                ("enabled", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="ceremony_templates_created",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "program",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="ceremony_templates",
                        to="projects.program",
                    ),
                ),
            ],
            options={
                "db_table": "projects_ceremony_template",
                "ordering": ["name"],
            },
        ),
        migrations.AddConstraint(
            model_name="ceremonytemplate",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_deleted", False)),
                fields=("program", "name"),
                name="ceremony_template_unique_name_per_program",
            ),
        ),
        migrations.CreateModel(
            name="PhaseGateConfig",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                (
                    "deleted_version",
                    models.BigIntegerField(blank=True, editable=False, null=True),
                ),
                ("enabled", models.BooleanField(default=False)),
                ("invite_template", models.TextField(blank=True, default="")),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "program",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="phase_gate_config",
                        to="projects.program",
                    ),
                ),
            ],
            options={
                "db_table": "projects_phase_gate_config",
            },
        ),
        migrations.CreateModel(
            name="HistoricalCeremonyTemplate",
            fields=[
                (
                    "id",
                    models.UUIDField(db_index=True, default=uuid.uuid4, editable=False),
                ),
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                ("name", models.CharField(max_length=120)),
                (
                    "cadence_type",
                    models.CharField(
                        choices=[
                            ("weekly", "Weekly"),
                            ("biweekly", "Bi-weekly"),
                            ("monthly", "Monthly"),
                            ("on_milestone", "On milestone"),
                        ],
                        max_length=16,
                    ),
                ),
                ("cadence_day", models.CharField(blank=True, default="", max_length=32)),
                ("cadence_time", models.TimeField(blank=True, null=True)),
                ("duration_minutes", models.PositiveSmallIntegerField(default=60)),
                ("owner_role", models.CharField(blank=True, default="", max_length=64)),
                ("enabled", models.BooleanField(default=True)),
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
                (
                    "program",
                    models.ForeignKey(
                        blank=True,
                        db_constraint=False,
                        null=True,
                        on_delete=django.db.models.deletion.DO_NOTHING,
                        related_name="+",
                        to="projects.program",
                    ),
                ),
            ],
            options={
                "verbose_name": "historical ceremony template",
                "verbose_name_plural": "historical ceremony templates",
                "ordering": ("-history_date", "-history_id"),
                "get_latest_by": ("history_date", "history_id"),
            },
            bases=(simple_history.models.HistoricalChanges, models.Model),
        ),
    ]
