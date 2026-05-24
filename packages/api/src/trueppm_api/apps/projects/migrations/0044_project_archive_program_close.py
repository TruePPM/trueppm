"""Issue #530: lifecycle fields for Project (archive) and Program (close).

Migration safety:
- All new columns are nullable or carry a safe default — no NOT NULL
  without default, no destructive ops, no FK constraint changes on
  existing rows.
- ``is_archived`` / ``is_closed``: ``BooleanField(default=False, db_index=True)``.
  Existing rows backfill to ``False`` (active/open).
- ``archived_at`` / ``closed_at``: ``DateTimeField(null=True, blank=True)``.
  Existing rows get ``NULL`` (never archived/closed).
- ``archived_by`` / ``closed_by``: ``ForeignKey(User, null=True, blank=True,
  on_delete=SET_NULL)``. SET_NULL so a user-account deletion does not
  cascade to archive/close history.
- HistoricalProject and HistoricalProgram receive the same fields with
  ``db_constraint=False`` and ``related_name="+"`` per simple-history
  conventions (mirrors 0040 / 0041).
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0043_merge_20260522_1118"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # --- Project: archive lifecycle ------------------------------------
        migrations.AddField(
            model_name="project",
            name="is_archived",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name="project",
            name="archived_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="project",
            name="archived_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="projects_archived",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="historicalproject",
            name="is_archived",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name="historicalproject",
            name="archived_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="historicalproject",
            name="archived_by",
            field=models.ForeignKey(
                blank=True,
                db_constraint=False,
                null=True,
                on_delete=django.db.models.deletion.DO_NOTHING,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        # --- Program: close lifecycle --------------------------------------
        migrations.AddField(
            model_name="program",
            name="is_closed",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name="program",
            name="closed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="program",
            name="closed_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="programs_closed",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="is_closed",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="closed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="closed_by",
            field=models.ForeignKey(
                blank=True,
                db_constraint=False,
                null=True,
                on_delete=django.db.models.deletion.DO_NOTHING,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
