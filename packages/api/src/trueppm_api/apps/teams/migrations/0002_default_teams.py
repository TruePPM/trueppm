"""Data migration: create one default Team per existing project and mirror
ProjectMembership rows onto it (ADR-0078 §C).

One-way and idempotent (get_or_create-shaped) so a re-run is a no-op. Forward
only: the reverse is RunPython.noop because dropping migration-created teams
would also strand any facets assigned afterward.
"""

from __future__ import annotations

from typing import Any

from django.db import migrations

# Project Role.ADMIN ordinal (ADR-0072). Project Admin (300) and Owner (400)
# become team Admin; everyone else is a team Member. Pinned as a literal here —
# a data migration must stay frozen against the model-time enum, and the band
# boundary is a stable contract — with the symbolic source named for the reader.
_TEAM_ADMIN_ROLE_THRESHOLD = 300  # Role.ADMIN


def create_default_teams(apps: Any, schema_editor: Any) -> None:
    Project = apps.get_model("projects", "Project")
    ProjectMembership = apps.get_model("access", "ProjectMembership")
    Team = apps.get_model("teams", "Team")
    TeamMembership = apps.get_model("teams", "TeamMembership")

    for project in Project.objects.filter(is_deleted=False).iterator():
        team, _created = Team.objects.get_or_create(
            project=project,
            is_default=True,
            is_deleted=False,
            defaults={
                "name": "Default Team",
                "short_id": "T01",
                # Historical models bypass VersionedModel.save(), so stamp the
                # initial server_version explicitly rather than leaving it 0.
                "server_version": 1,
            },
        )

        for pm in ProjectMembership.objects.filter(project=project, is_deleted=False).iterator():
            team_role = "admin" if pm.role >= _TEAM_ADMIN_ROLE_THRESHOLD else "member"
            TeamMembership.objects.get_or_create(
                team=team,
                user_id=pm.user_id,
                is_deleted=False,
                # Facets are never inferred (ADR-0078 §C step 3): both default
                # False, explicit assignment required afterward.
                defaults={"role": team_role, "server_version": 1},
            )


class Migration(migrations.Migration):
    dependencies = [
        ("teams", "0001_initial"),
        ("access", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(create_default_teams, migrations.RunPython.noop),
    ]
