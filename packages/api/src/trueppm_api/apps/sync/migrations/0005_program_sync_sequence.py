"""Installation-wide allocator for the program sync cursor (ADR-0747, #2498).

Creates the singleton counter, then seeds it and both program tables' ``sync_seq``
in one ordered pass. The backfill logic lives in ``apps/sync/backfill.py`` so tests
can import it without referencing this file's name (CLAUDE.md migration rule 3).
"""

from django.db import migrations, models

from trueppm_api.apps.sync.backfill import seed_program_sync_seq, unseed_program_sync_seq


class Migration(migrations.Migration):
    dependencies = [
        ("sync", "0004_seed_sync_seq"),
        # The backfill reads both tables' server_version and writes their sync_seq,
        # so both columns must already exist.
        ("projects", "0128_acceptancecriterion_sync_seq_apitoken_sync_seq_and_more"),
        ("access", "0018_programmembership_sync_seq_and_more"),
    ]

    operations = [
        migrations.CreateModel(
            name="ProgramSyncSequence",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                ("value", models.BigIntegerField(default=0, editable=False)),
            ],
            options={
                "verbose_name": "program sync sequence",
                "verbose_name_plural": "program sync sequence",
            },
        ),
        migrations.RunPython(seed_program_sync_seq, unseed_program_sync_seq, elidable=True),
    ]
