from typing import Any

from django.db import migrations


def backfill_sprint_to_inherit(apps: Any, schema_editor: Any) -> None:
    """Clear the ADR-0111 default "Sprint" to NULL (inherit) on existing projects.

    ADR-0116: #1106 lands ~1 day after #862, so an *explicit* project label of
    "Sprint" is indistinguishable from the shipped default and resolves identically
    today. Clearing it to NULL lets a project nobody customized follow a future
    workspace/program default instead of being pinned to "Sprint" forever. Custom
    labels (anything other than "Sprint") are preserved as explicit overrides.

    ``.update()`` is a bulk write that bypasses HistoricalRecords — the backfill is
    a one-time data correction, not an audited user edit, so it leaves no history row.
    """
    Project = apps.get_model("projects", "Project")
    Project.objects.filter(iteration_label="Sprint").update(iteration_label=None)


def restore_inherit_to_sprint(apps: Any, schema_editor: Any) -> None:
    """Reverse: re-materialize NULL (inherit) back to the literal "Sprint"."""
    Project = apps.get_model("projects", "Project")
    Project.objects.filter(iteration_label__isnull=True).update(iteration_label="Sprint")


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0070_historicalprogram_iteration_label_and_more"),
    ]

    operations = [
        migrations.RunPython(backfill_sprint_to_inherit, restore_inherit_to_sprint, elidable=True),
    ]
