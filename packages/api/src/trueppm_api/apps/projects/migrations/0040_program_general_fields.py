"""Issue #523: extend Program with code, health, visibility, and lead fields.

Migration safety:
- All four new columns are nullable or carry a safe default — no NOT NULL
  without default, no destructive ops.
- ``code``: ``CharField(max_length=40, blank=True, default="")``. Existing
  rows receive ``""`` at column-add time.
- ``health``: ``CharField(choices=Health, default="AUTO")``. Existing rows
  resolve to AUTO, which defers to the (future) rollup rather than implying
  a manual judgment.
- ``visibility``: ``CharField(choices=Visibility, default="WORKSPACE")``.
  Existing rows default to WORKSPACE — the listing-scope enforcement is a
  future change so this is an inert backfill today.
- ``lead``: ``ForeignKey(User, null=True, blank=True, on_delete=SET_NULL)``.
  Existing rows get NULL; the UI surfaces ``created_by`` as a fallback only
  when the lead field is empty.
- HistoricalProgram receives the same four fields with ``db_constraint=False``
  and ``related_name="+"`` per simple-history conventions (mirrors
  HistoricalProject.program in 0036).
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0039_apitoken_and_more"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="program",
            name="code",
            field=models.CharField(blank=True, default="", max_length=40),
        ),
        migrations.AddField(
            model_name="program",
            name="health",
            field=models.CharField(
                choices=[
                    ("AUTO", "Auto"),
                    ("ON_TRACK", "On track"),
                    ("AT_RISK", "At risk"),
                    ("CRITICAL", "Critical"),
                ],
                default="AUTO",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="program",
            name="visibility",
            field=models.CharField(
                choices=[
                    ("WORKSPACE", "Workspace"),
                    ("PRIVATE", "Private"),
                ],
                default="WORKSPACE",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="program",
            name="lead",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="programs_led",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="code",
            field=models.CharField(blank=True, default="", max_length=40),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="health",
            field=models.CharField(
                choices=[
                    ("AUTO", "Auto"),
                    ("ON_TRACK", "On track"),
                    ("AT_RISK", "At risk"),
                    ("CRITICAL", "Critical"),
                ],
                default="AUTO",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="visibility",
            field=models.CharField(
                choices=[
                    ("WORKSPACE", "Workspace"),
                    ("PRIVATE", "Private"),
                ],
                default="WORKSPACE",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="lead",
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
