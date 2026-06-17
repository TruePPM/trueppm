"""Composite index for the velocity rollup scan on Sprint (ADR-0113)."""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    """Add a composite index on Sprint(project, exclude_from_velocity, state, -closed_at).

    ``velocity_eligible_sprints()`` scans the velocity-eligible set with
    ``WHERE project_id = X AND exclude_from_velocity = false AND
    state = 'COMPLETED' ORDER BY closed_at DESC``. The leading equality
    columns let PostgreSQL seek directly to the eligible rows and the
    trailing ``closed_at`` supplies the newest-first sort order, so the
    rolling-window slice needs no separate sort step. None of the existing
    Sprint indexes (project+state, project+start_date, project+server_version)
    cover the ``exclude_from_velocity`` predicate or the closed_at ordering.
    """

    dependencies = [
        ("projects", "0084_tasknote"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="sprint",
            index=models.Index(
                fields=["project", "exclude_from_velocity", "state", "-closed_at"],
                name="ix_sprint_velocity",
            ),
        ),
    ]
