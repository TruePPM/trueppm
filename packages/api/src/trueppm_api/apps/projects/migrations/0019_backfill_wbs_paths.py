"""Backfill wbs_path for tasks that were created before auto-assignment was added.

Tasks with null wbs_path have no hierarchy information (parent_id is derived
from wbs_path, not stored separately), so they are assigned sequential root-level
paths within their project, ordered by short_id (project-scoped insertion order).
"""

from __future__ import annotations

from django.db import migrations

from trueppm_api.apps.projects.backfill import _backfill_wbs_paths


def _noop(apps: object, schema_editor: object) -> None:
    # Reversing would require knowing the original null state, which is not
    # stored.  Accept data loss on reverse — this migration is additive only.
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0018_estimation_governance"),
    ]

    operations = [
        migrations.RunPython(_backfill_wbs_paths, _noop, elidable=True),
    ]
