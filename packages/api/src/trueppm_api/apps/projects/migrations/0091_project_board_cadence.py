from django.db import migrations, models


class Migration(migrations.Migration):
    """Add Project.board_cadence (ADR-0164, #410).

    Additive, non-destructive: default ``sprint`` preserves every existing project's
    current board behavior. Added to both ``project`` and ``historicalproject`` so the
    change is captured in the django-simple-history audit trail.

    NOTE: the ``projects`` app is a known migration-collision zone — if another 0091
    landed on main after this branch was cut, renumber at rebase (run
    ``manage.py makemigrations --check`` and inspect the leaf set).
    """

    dependencies = [
        ("projects", "0090_historicaltask_proj_histdate_index"),
    ]

    operations = [
        migrations.AddField(
            model_name="historicalproject",
            name="board_cadence",
            field=models.CharField(
                choices=[("sprint", "Sprint-based"), ("continuous", "Continuous flow (Kanban)")],
                default="sprint",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="project",
            name="board_cadence",
            field=models.CharField(
                choices=[("sprint", "Sprint-based"), ("continuous", "Continuous flow (Kanban)")],
                default="sprint",
                max_length=16,
            ),
        ),
    ]
