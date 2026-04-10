"""Backfill short_id for existing Tasks and Risks (ADR-0016).

Assigns sequential hex IDs ordered by PK (UUID, deterministic but arbitrary).
Sets Project.object_sequence to the highest assigned value.
"""

from django.db import migrations


def backfill_short_ids(apps, schema_editor):
    Project = apps.get_model("projects", "Project")
    Task = apps.get_model("projects", "Task")
    Risk = apps.get_model("projects", "Risk")

    for project in Project.objects.all():
        seq = 0
        # Backfill tasks ordered by PK for deterministic assignment.
        for task in Task.objects.filter(project=project).order_by("id"):
            seq += 1
            Task.objects.filter(pk=task.pk).update(short_id=f"{seq:08X}")
        # Continue the same counter for risks.
        for risk in Risk.objects.filter(project=project).order_by("id"):
            seq += 1
            Risk.objects.filter(pk=risk.pk).update(short_id=f"{seq:08X}")
        # Persist the counter so new objects continue the sequence.
        if seq > 0:
            Project.objects.filter(pk=project.pk).update(object_sequence=seq)


def reverse_backfill(apps, schema_editor):
    Task = apps.get_model("projects", "Task")
    Risk = apps.get_model("projects", "Risk")
    Project = apps.get_model("projects", "Project")
    Task.objects.all().update(short_id="")
    Risk.objects.all().update(short_id="")
    Project.objects.all().update(object_sequence=0)


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0014_short_hex_ids"),
    ]

    operations = [
        migrations.RunPython(backfill_short_ids, reverse_backfill),
    ]
