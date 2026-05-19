"""ADR-0070: introduce Program entity and Project.program FK.

Migration safety:
- ``Program`` and its history shadow table are NEW models — no existing rows
  to migrate. Reversible via standard CreateModel rollback.
- ``Project.program`` is a NEW nullable FK with no default. Existing rows
  receive NULL (= standalone project) at column-add time, which is the
  intended semantics — projects remain fully functional and standalone
  unless explicitly grouped into a Program by a PM.
- No destructive operations, no NOT NULL columns without defaults, no
  data migrations. Pure schema add.
- The companion access migration 0005_program_entity_and_membership creates
  ``ProgramMembership`` and depends on this migration (FK target).
"""

import uuid

import django.db.models.deletion
import simple_history.models
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0035_retro_versioned_and_suggested_assignee"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="HistoricalProgram",
            fields=[
                ("id", models.UUIDField(db_index=True, default=uuid.uuid4, editable=False)),
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                ("name", models.CharField(max_length=255)),
                ("description", models.TextField(blank=True, default="")),
                (
                    "methodology",
                    models.CharField(
                        choices=[
                            ("WATERFALL", "Waterfall"),
                            ("AGILE", "Agile"),
                            ("HYBRID", "Hybrid"),
                        ],
                        default="HYBRID",
                        max_length=16,
                    ),
                ),
                ("created_at", models.DateTimeField(blank=True, editable=False)),
                ("updated_at", models.DateTimeField(blank=True, editable=False)),
                ("history_id", models.AutoField(primary_key=True, serialize=False)),
                ("history_date", models.DateTimeField(db_index=True)),
                ("history_change_reason", models.CharField(max_length=100, null=True)),
                (
                    "history_type",
                    models.CharField(
                        choices=[("+", "Created"), ("~", "Changed"), ("-", "Deleted")], max_length=1
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
                "verbose_name": "historical program",
                "verbose_name_plural": "historical programs",
                "ordering": ("-history_date", "-history_id"),
                "get_latest_by": ("history_date", "history_id"),
            },
            bases=(simple_history.models.HistoricalChanges, models.Model),
        ),
        migrations.CreateModel(
            name="Program",
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
                ("name", models.CharField(max_length=255)),
                ("description", models.TextField(blank=True, default="")),
                (
                    "methodology",
                    models.CharField(
                        choices=[
                            ("WATERFALL", "Waterfall"),
                            ("AGILE", "Agile"),
                            ("HYBRID", "Hybrid"),
                        ],
                        default="HYBRID",
                        max_length=16,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="programs_created",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "projects_program",
                "ordering": ["name"],
            },
        ),
        migrations.AddField(
            model_name="historicalproject",
            name="program",
            field=models.ForeignKey(
                blank=True,
                db_constraint=False,
                null=True,
                on_delete=django.db.models.deletion.DO_NOTHING,
                related_name="+",
                to="projects.program",
            ),
        ),
        migrations.AddField(
            model_name="project",
            name="program",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="projects",
                to="projects.program",
            ),
        ),
    ]
