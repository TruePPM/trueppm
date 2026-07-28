"""ADR-0072 Amendment 1 (#2489): choices metadata for the VIEWER 0 → 1 move.

Schema-only. ``GroupProject.role`` embeds ``Role.choices`` at import time, so the
choice list has to be re-stated here; the row backfill for every Role-bearing column
(this one included) lives in the single atomic RunPython in
``access/0017_viewer_ordinal_one.py``, which depends on this migration.
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("workspace", "0019_historicalworkspace_mcp_enabled_and_more"),
    ]

    operations = [
        migrations.AlterField(
            model_name="groupproject",
            name="role",
            field=models.IntegerField(
                choices=[
                    (1, "Viewer"),
                    (100, "Team Member"),
                    (200, "Resource Manager"),
                    (300, "Project Manager"),
                    (400, "Project Admin"),
                ],
                default=100,
            ),
        ),
    ]
