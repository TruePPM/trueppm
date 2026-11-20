"""Make PRIVATE the visibility default and pin every existing row to it (ADR-1434).

Before #2066 ``visibility`` was stored but never read: every project and program
was membership-scoped whatever its value, and the default was WORKSPACE. Enforcing
WORKSPACE as written would have silently opened every existing row's record to
the whole workspace on upgrade. This migration preserves the access every install
actually had: all existing rows become PRIVATE (exactly today's effective
behavior), and new rows default to PRIVATE, so a project or program becomes
workspace-visible only when an admin chooses WORKSPACE in General settings.

The backfill is a bulk ``.update()``: it does not bump ``server_version``, so an
offline client may show the old WORKSPACE label until the row next changes. The
label is display-only on the client; the server is the authority on access.
"""

from typing import Any

from django.db import migrations, models


def pin_existing_rows_private(apps: Any, schema_editor: Any) -> None:
    """Set every existing project and program to PRIVATE (preserves pre-#2066 access)."""
    for model_name in ("Project", "Program"):
        model = apps.get_model("projects", model_name)
        model.objects.exclude(visibility="PRIVATE").update(visibility="PRIVATE")


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0180_tombstone_deleted_at"),
    ]

    operations = [
        migrations.AlterField(
            model_name="historicalprogram",
            name="visibility",
            field=models.CharField(
                choices=[("WORKSPACE", "Workspace"), ("PRIVATE", "Private")],
                default="PRIVATE",
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="historicalproject",
            name="visibility",
            field=models.CharField(
                choices=[("WORKSPACE", "Workspace"), ("PRIVATE", "Private")],
                default="PRIVATE",
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="program",
            name="visibility",
            field=models.CharField(
                choices=[("WORKSPACE", "Workspace"), ("PRIVATE", "Private")],
                default="PRIVATE",
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="project",
            name="visibility",
            field=models.CharField(
                choices=[("WORKSPACE", "Workspace"), ("PRIVATE", "Private")],
                default="PRIVATE",
                max_length=16,
            ),
        ),
        migrations.RunPython(pin_existing_rows_private, migrations.RunPython.noop),
    ]
