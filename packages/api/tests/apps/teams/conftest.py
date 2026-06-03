"""Shared fixtures for teams app tests (ADR-0078, #927).

The API/permission tests create the default team and its memberships explicitly
rather than relying on the auto-membership signal: under the standard ``db``
fixture, the signal's ``transaction.on_commit`` callback does not fire. The
signal behavior itself is exercised separately in ``test_teams_signals.py`` with
``django_capture_on_commit_callbacks``.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

User = get_user_model()


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1))


@pytest.fixture
def default_team(project: Project) -> Team:
    return Team.objects.create(
        project=project, name="Default Team", short_id="T01", is_default=True
    )


# -- Users + project memberships (role on the *project* axis) -----------------


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def project_admin(db: object) -> Any:
    return User.objects.create_user(username="proj_admin", password="pw")


@pytest.fixture
def member(db: object) -> Any:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def viewer(db: object) -> Any:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def outsider(db: object) -> Any:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def memberships(project: Project, owner: Any, project_admin: Any, member: Any, viewer: Any) -> None:
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=project, user=project_admin, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)


@pytest.fixture
def team_members(
    default_team: Team, memberships: None, owner: Any, project_admin: Any, member: Any, viewer: Any
) -> dict[str, TeamMembership]:
    """Mirror the project memberships onto the default team (admins -> team admin)."""
    return {
        "owner": TeamMembership.objects.create(team=default_team, user=owner, role=TeamRole.ADMIN),
        "project_admin": TeamMembership.objects.create(
            team=default_team, user=project_admin, role=TeamRole.ADMIN
        ),
        "member": TeamMembership.objects.create(
            team=default_team, user=member, role=TeamRole.MEMBER
        ),
        "viewer": TeamMembership.objects.create(
            team=default_team, user=viewer, role=TeamRole.MEMBER
        ),
    }


# -- Clients ------------------------------------------------------------------


@pytest.fixture
def admin_client(project_admin: Any) -> APIClient:
    return _client(project_admin)


@pytest.fixture
def member_client(member: Any) -> APIClient:
    return _client(member)


@pytest.fixture
def viewer_client(viewer: Any) -> APIClient:
    return _client(viewer)


@pytest.fixture
def outsider_client(outsider: Any) -> APIClient:
    return _client(outsider)
