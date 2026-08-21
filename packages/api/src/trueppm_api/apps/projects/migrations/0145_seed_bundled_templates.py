"""Seed the starter templates that ship with the install (#2909).

A data migration rather than a management command because the failure being fixed
is that a **fresh install** has an empty Template way-in. Anything an operator has
to remember to run leaves the default install exactly as broken as it was.

Idempotent on name, and additive: an operator who has deleted or unpublished a
starter does not get it back on the next migrate, because `get_or_create` matches
the row whether it is published or not. Reversing drops only untouched starters —
a row somebody has adopted from is left alone.
"""

from __future__ import annotations

from typing import Any

from django.db import migrations


def seed(apps: Any, schema_editor: Any) -> None:
    ProjectTemplate = apps.get_model("projects", "ProjectTemplate")
    from trueppm_api.apps.projects.bundled_templates import BUNDLED_TEMPLATES

    for name, description, build in BUNDLED_TEMPLATES:
        structure = build()
        ProjectTemplate.objects.get_or_create(
            name=name,
            defaults={
                "description": description,
                # COMMUNITY is what the gallery labels "Bundled" and sorts last.
                "source_kind": "community",
                "structure": structure,
                "carries": structure.get("carries", []),
                "is_published": True,
                # No owner and no source project: nobody in this workspace
                # published them, and claiming otherwise would put a name on the
                # provenance line that means nothing to the reader.
                "owner": None,
                "published_by": None,
                "program": None,
            },
        )


def unseed(apps: Any, schema_editor: Any) -> None:
    ProjectTemplate = apps.get_model("projects", "ProjectTemplate")
    from trueppm_api.apps.projects.bundled_templates import BUNDLED_TEMPLATE_NAMES

    # Only starters nobody has adopted from. Deleting a template that seeded a
    # running project would strip the adoption record's only remaining pointer.
    ProjectTemplate.objects.filter(
        name__in=BUNDLED_TEMPLATE_NAMES,
        source_kind="community",
        applications__isnull=True,
    ).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0144_projecttemplate_source_project_and_more"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
