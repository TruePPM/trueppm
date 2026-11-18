"""Issue #527: extend Program with rollup_enabled_kpis + rollup_aggregation_policy.

Migration safety:
- Both new columns carry safe defaults — no NOT NULL without default, no
  destructive ops.
- ``rollup_enabled_kpis``: ``JSONField(default=list, blank=True)``. Existing
  rows receive ``[]`` at column-add time; the RunPython step then overwrites
  with methodology-aware defaults (see ``rollup_config_defaults`` in
  services.py).
- ``rollup_aggregation_policy``: ``CharField(choices=AggregationPolicy,
  default="worst")``. Existing rows resolve to "worst" — the recommended
  default, matching the VoC panel's preferred policy.
- HistoricalProgram receives the same two fields per simple-history
  conventions (audit shadow follows the model schema).

Data migration backfills both columns on existing programs using the same
service-layer helper that the post_save signal will use for new programs.
Reverse: clear both columns back to ``([], "worst")``.
"""

from typing import Any

from django.db import migrations, models


def _seed_existing_programs(apps: Any, schema_editor: Any) -> None:
    """Backfill methodology-aware rollup defaults on every existing Program.

    Uses a frozen copy of the defaults (``projects.backfill``) rather than the live
    services module, so a later change to the live defaults cannot alter what this
    migration seeds on a fresh install (#4603).
    """
    from trueppm_api.apps.projects.backfill import frozen_rollup_config_defaults

    Program = apps.get_model("projects", "Program")
    for program in Program.objects.all():
        enabled, policy = frozen_rollup_config_defaults(program.methodology)
        program.rollup_enabled_kpis = enabled
        program.rollup_aggregation_policy = policy
        program.save(update_fields=["rollup_enabled_kpis", "rollup_aggregation_policy"])


def _clear_rollup_config(apps: Any, schema_editor: Any) -> None:
    Program = apps.get_model("projects", "Program")
    Program.objects.update(rollup_enabled_kpis=[], rollup_aggregation_policy="worst")


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0041_project_general_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="program",
            name="rollup_enabled_kpis",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="program",
            name="rollup_aggregation_policy",
            field=models.CharField(
                choices=[
                    ("worst", "Worst-case"),
                    ("average", "Average"),
                    ("weighted_by_budget", "Budget-weighted"),
                    ("task_weighted", "Task-weighted"),
                ],
                default="worst",
                max_length=24,
            ),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="rollup_enabled_kpis",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="rollup_aggregation_policy",
            field=models.CharField(
                choices=[
                    ("worst", "Worst-case"),
                    ("average", "Average"),
                    ("weighted_by_budget", "Budget-weighted"),
                    ("task_weighted", "Task-weighted"),
                ],
                default="worst",
                max_length=24,
            ),
        ),
        migrations.RunPython(
            _seed_existing_programs, reverse_code=_clear_rollup_config, elidable=True
        ),
    ]
