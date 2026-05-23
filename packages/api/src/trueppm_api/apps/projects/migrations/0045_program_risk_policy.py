"""Issue #529: extend Program with risk_slip_propagation + risk_escalation_days.

Migration safety:
- Both new columns carry safe defaults — no NOT NULL without default, no
  destructive ops.
- ``risk_slip_propagation``: ``CharField(choices=SlipPropagation,
  default="warn")``. Existing rows resolve to "warn" — matches the issue
  spec ("Warn only" is the default rung between "No action" and
  "Block & escalate").
- ``risk_escalation_days``: ``PositiveSmallIntegerField(default=3,
  validators=[MinValueValidator(1), MaxValueValidator(30)])``. Existing
  rows resolve to 3 — same default as the previous hardcoded UI state.
- HistoricalProgram receives the same two fields per simple-history
  conventions (audit shadow follows the model schema).

No data migration: AddField applies the field defaults to every existing
row at column-add time, which is exactly what the issue spec requires.
"""

import django.core.validators
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0044_merge_20260522_rollup"),
    ]

    operations = [
        migrations.AddField(
            model_name="program",
            name="risk_slip_propagation",
            field=models.CharField(
                choices=[
                    ("none", "No action"),
                    ("warn", "Warn only"),
                    ("block", "Block & escalate"),
                ],
                default="warn",
                max_length=8,
            ),
        ),
        migrations.AddField(
            model_name="program",
            name="risk_escalation_days",
            field=models.PositiveSmallIntegerField(
                default=3,
                validators=[
                    django.core.validators.MinValueValidator(1),
                    django.core.validators.MaxValueValidator(30),
                ],
            ),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="risk_slip_propagation",
            field=models.CharField(
                choices=[
                    ("none", "No action"),
                    ("warn", "Warn only"),
                    ("block", "Block & escalate"),
                ],
                default="warn",
                max_length=8,
            ),
        ),
        migrations.AddField(
            model_name="historicalprogram",
            name="risk_escalation_days",
            field=models.PositiveSmallIntegerField(
                default=3,
                validators=[
                    django.core.validators.MinValueValidator(1),
                    django.core.validators.MaxValueValidator(30),
                ],
            ),
        ),
    ]
