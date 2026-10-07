"""teams 0004 re-runs ``create_default_teams`` for installs the squash never reached (#4320).

The ``teams`` app has no unsquashed released history (0001_initial and
0002_default_teams both first shipped already combined into
0001_squashed_0002_default_teams, v0.3.0-alpha.1). An install upgrading from before
teams existed applies *only* the squash for this app, against real pre-existing
``Project``/``ProjectMembership`` rows — so until the squash itself carried the
restored data step, the default-team backfill never ran for that population and
never will on its own. ``teams/migrations/0004_backfill_default_teams_on_upgrade.py``
closes that gap directly, as a non-elidable migration every install (fresh or
upgrading, healed or not) now applies.

These tests exercise the real ``create_default_teams`` callable, resolved through
Django's migration loader (never imported by module name, CLAUDE.md migration
rule 3) and invoked against the live app registry — the same shape
``test_matrix_cleanup_upgrade.py`` uses to test a migration's data step without
asserting on migration *file names*.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.apps import apps as global_apps
from django.contrib.auth import get_user_model
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.operations import RunPython

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.teams.models import Team, TeamMembership

User = get_user_model()
_BACKFILL = ("teams", "0004_backfill_default_teams_on_upgrade")


def _resolve_create_default_teams() -> Any:
    loader = MigrationLoader(None, ignore_no_migrations=True)
    migration = loader.disk_migrations[_BACKFILL]
    for op in migration.operations:
        if isinstance(op, RunPython) and not op.code.__qualname__.endswith("noop"):
            return op.code
    raise AssertionError("teams 0004 no longer carries a create_default_teams RunPython op")


@pytest.mark.django_db
def test_backfill_creates_default_team_on_an_upgraded_install_with_none() -> None:
    """Simulates a database whose teams app went straight to the squash with no healing.

    Real pre-existing Project + ProjectMembership rows, no Team at all — the
    population the squash restoration alone cannot reach because it is only
    applied once, and already was for this hypothetical install.
    """
    project = Project.objects.create(name="Proj", start_date=date(2026, 1, 1))
    owner = User.objects.create_user(username="owner", password="pw")
    member = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    assert not Team.objects.filter(project=project).exists()

    create_default_teams = _resolve_create_default_teams()
    create_default_teams(global_apps, None)

    team = Team.objects.get(project=project, is_default=True, is_deleted=False)
    assert TeamMembership.objects.filter(team=team, user=owner, role="admin").exists()
    assert TeamMembership.objects.filter(team=team, user=member, role="member").exists()


@pytest.mark.django_db
def test_backfill_is_a_noop_when_a_default_team_already_exists() -> None:
    """Fresh installs (squash already created the team) and healed installs alike.

    Re-running must not create a second default team or duplicate memberships —
    the idempotency ``create_default_teams``'s own docstring promises.
    """
    project = Project.objects.create(name="Proj", start_date=date(2026, 1, 1))
    owner = User.objects.create_user(username="owner", password="pw")
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    team = Team.objects.create(
        project=project,
        name="Default Team",
        short_id="T01",
        is_default=True,
        server_version=1,
    )
    TeamMembership.objects.create(team=team, user=owner, role="admin", server_version=1)

    create_default_teams = _resolve_create_default_teams()
    create_default_teams(global_apps, None)

    assert Team.objects.filter(project=project, is_deleted=False).count() == 1
    assert TeamMembership.objects.filter(team=team, is_deleted=False).count() == 1
