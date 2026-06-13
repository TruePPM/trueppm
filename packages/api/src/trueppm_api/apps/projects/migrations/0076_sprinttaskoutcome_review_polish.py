# Sprint Review polish (Wave D, #1130/#1131/#1132) — adds the demo-ordering,
# presenter, contributor-note, and carry-forward fields to SprintTaskOutcome.
#
# NOTE: this is projects migration 0076. Wave B (#1135) also plans a projects/0076
# on a parallel branch — a known collision. If another 0076 merges first, renumber
# this file to the next free number and repoint its dependency. All four fields are
# additive with safe defaults (no NOT NULL without default, fully reversible).

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0075_risk_decimal_short_id"),
    ]

    operations = [
        migrations.AddField(
            model_name="sprinttaskoutcome",
            name="demo_order",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="sprinttaskoutcome",
            name="presenter",
            field=models.CharField(blank=True, default="", max_length=120),
        ),
        migrations.AddField(
            model_name="sprinttaskoutcome",
            name="review_note",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="sprinttaskoutcome",
            name="flagged_to_backlog_task",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to="projects.task",
            ),
        ),
    ]
