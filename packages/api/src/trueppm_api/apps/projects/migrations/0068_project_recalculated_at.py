from django.db import migrations, models


class Migration(migrations.Migration):
    """Add Project.recalculated_at (ADR-0114 / #1053).

    Stamped by the CPM recalc task on success so the web Schedule view can show
    a "recalculating" badge until the first post-import pass lands. The field is
    excluded from history (a non-domain timestamp), so there is no matching
    historicalproject column — a single AddField on the live table.
    """

    dependencies = [
        ("projects", "0067_sprint_exclude_from_velocity"),
    ]

    operations = [
        migrations.AddField(
            model_name="project",
            name="recalculated_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
