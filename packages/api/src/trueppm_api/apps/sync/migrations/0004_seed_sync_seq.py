"""Seed the per-project sync delta cursor for existing data (ADR-0686, #2491).

Runs after every app that adds the ``sync_seq`` column, because the renumber
touches all of them in one pass. The logic lives in ``apps/sync/backfill.py`` so
tests can import it without referencing this file's name (CLAUDE.md rule 3).
"""

from django.db import migrations

from trueppm_api.apps.sync.backfill import seed_sync_seq, unseed_sync_seq


class Migration(migrations.Migration):
    dependencies = [
        ("sync", "0003_boardevent"),
        ("projects", "0128_acceptancecriterion_sync_seq_apitoken_sync_seq_and_more"),
        ("access", "0018_programmembership_sync_seq_and_more"),
        ("integrations", "0011_tasklink_sync_seq_tasklink_tasklink_syncseq_idx"),
        ("timetracking", "0004_timeentry_sync_seq_and_more"),
    ]

    operations = [
        migrations.RunPython(seed_sync_seq, unseed_sync_seq, elidable=True),
    ]
