"""Add actual_start and actual_finish to Task and BaselineTask."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0015_backfill_short_ids"),
    ]

    operations = [
        migrations.AddField(
            model_name="task",
            name="actual_start",
            field=models.DateField(blank=True, db_index=True, null=True),
        ),
        migrations.AddField(
            model_name="task",
            name="actual_finish",
            field=models.DateField(blank=True, db_index=True, null=True),
        ),
        migrations.AddField(
            model_name="baselinetask",
            name="actual_start",
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="baselinetask",
            name="actual_finish",
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="historicaltask",
            name="actual_start",
            field=models.DateField(blank=True, db_index=True, null=True),
        ),
        migrations.AddField(
            model_name="historicaltask",
            name="actual_finish",
            field=models.DateField(blank=True, db_index=True, null=True),
        ),
    ]
