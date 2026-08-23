"""Facet-resolution helpers and the auto-membership invariant (ADR-0078, #927).

These cover the seam downstream gates (ADR-0104 signal privacy, ADR-0102 scope
injection) read: ``has_team_facet`` / ``user_facets``. The headline assertion is
that an *admin without the facet* does NOT pass the facet gate — role and facet
are independent axes.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole
from trueppm_api.apps.teams.services import (
    ensure_team_membership,
    facet_holder_user_ids,
    has_team_facet,
    project_role_to_team_role,
    resolve_default_team,
    user_facets,
)

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1))


@pytest.fixture
def default_team(project: Project) -> Team:
    return Team.objects.create(
        project=project, name="Default Team", short_id="T01", is_default=True
    )


# ---------------------------------------------------------------------------
# Facet resolution
# ---------------------------------------------------------------------------


def test_admin_without_facet_does_not_pass_facet_gate(project: Project, default_team: Team) -> None:
    """An admin who is not the Scrum Master must NOT resolve the SM facet."""
    admin = User.objects.create_user(username="a", password="pw")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.OWNER)
    TeamMembership.objects.create(team=default_team, user=admin, role=TeamRole.ADMIN)

    assert has_team_facet(admin, project.pk, "is_scrum_master") is False
    assert user_facets(admin, project.pk) == {
        "is_scrum_master": False,
        "is_product_owner": False,
    }


def test_product_owner_facet_drives_gate(project: Project, default_team: Team) -> None:
    """A plain Member who holds the PO facet passes the PO gate (ADR-0102 seam)."""
    user = User.objects.create_user(username="po", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    TeamMembership.objects.create(
        team=default_team, user=user, role=TeamRole.MEMBER, is_product_owner=True
    )

    assert has_team_facet(user, project.pk, "is_product_owner") is True
    assert has_team_facet(user, project.pk, "is_scrum_master") is False


def test_facet_holder_user_ids_is_the_set_form_of_user_facets(
    project: Project, default_team: Team
) -> None:
    """The project-shaped counterpart returns exactly the users ``user_facets`` says hold one.

    Asserted as an equality against ``user_facets`` rather than against a hand-written
    expected set: the two answering the same question differently is the #2897 defect,
    and a hardcoded expectation would not catch a future divergence.
    """
    sm = User.objects.create_user(username="sm", password="pw")
    po = User.objects.create_user(username="po2", password="pw")
    both = User.objects.create_user(username="both", password="pw")
    neither = User.objects.create_user(username="neither", password="pw")
    admin_no_facet = User.objects.create_user(username="admin-nf", password="pw")

    TeamMembership.objects.create(team=default_team, user=sm, is_scrum_master=True)
    TeamMembership.objects.create(team=default_team, user=po, is_product_owner=True)
    TeamMembership.objects.create(
        team=default_team, user=both, is_scrum_master=True, is_product_owner=True
    )
    TeamMembership.objects.create(team=default_team, user=neither)
    TeamMembership.objects.create(team=default_team, user=admin_no_facet, role=TeamRole.ADMIN)

    everyone = [sm, po, both, neither, admin_no_facet]
    expected = {u.pk for u in everyone if any(user_facets(u, project.pk).values())}

    assert facet_holder_user_ids(project.pk) == expected
    assert facet_holder_user_ids(project.pk) == {sm.pk, po.pk, both.pk}


def test_facet_holder_user_ids_excludes_revoked_and_non_default_teams(
    project: Project, default_team: Team
) -> None:
    """Soft-deleted rows and non-default teams contribute nobody.

    Both filters are privacy-load-bearing downstream: the set feeds the sprint
    scope-change recipient cohort, so a revoked member left in it keeps receiving a
    project's task names, and a second team's PO would be told about a project whose
    default team they are not on.
    """
    revoked = User.objects.create_user(username="revoked", password="pw")
    TeamMembership.objects.create(
        team=default_team, user=revoked, is_product_owner=True, is_deleted=True
    )

    other_team = Team.objects.create(
        project=project, name="Squad B", short_id="T02", is_default=False
    )
    off_team = User.objects.create_user(username="off-team", password="pw")
    TeamMembership.objects.create(team=other_team, user=off_team, is_scrum_master=True)

    assert facet_holder_user_ids(project.pk) == set()


def test_user_facets_for_anonymous_and_nonmember(project: Project, default_team: Team) -> None:
    none = {"is_scrum_master": False, "is_product_owner": False}
    assert user_facets(AnonymousUser(), project.pk) == none
    stranger = User.objects.create_user(username="x", password="pw")
    assert user_facets(stranger, project.pk) == none


def test_has_team_facet_rejects_unknown_facet(project: Project) -> None:
    user = User.objects.create_user(username="u", password="pw")
    with pytest.raises(ValueError):
        has_team_facet(user, project.pk, "is_release_manager")


# ---------------------------------------------------------------------------
# Role mapping
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("project_role", "expected"),
    [
        (Role.VIEWER, TeamRole.MEMBER),
        (Role.MEMBER, TeamRole.MEMBER),
        (Role.SCHEDULER, TeamRole.MEMBER),
        (Role.ADMIN, TeamRole.ADMIN),
        (Role.OWNER, TeamRole.ADMIN),
    ],
)
def test_project_role_to_team_role(project_role: int, expected: str) -> None:
    assert project_role_to_team_role(project_role) == expected


# ---------------------------------------------------------------------------
# Auto-membership invariant
# ---------------------------------------------------------------------------


def test_ensure_team_membership_creates_default_team_on_demand(project: Project) -> None:
    """A project with no default team yet gets one materialized (post-migration projects)."""
    user = User.objects.create_user(username="m", password="pw")
    assert resolve_default_team(project.pk) is None

    ensure_team_membership(project_id=project.pk, user_id=user.pk, project_role=Role.MEMBER)

    team = resolve_default_team(project.pk)
    assert team is not None and team.is_default
    assert TeamMembership.objects.filter(team=team, user=user, role=TeamRole.MEMBER).exists()


def test_ensure_team_membership_maps_admin_role(project: Project, default_team: Team) -> None:
    user = User.objects.create_user(username="adm", password="pw")
    ensure_team_membership(project_id=project.pk, user_id=user.pk, project_role=Role.ADMIN)
    tm = TeamMembership.objects.get(team=default_team, user=user)
    assert tm.role == TeamRole.ADMIN


def test_ensure_team_membership_preserves_facets_on_role_change(
    project: Project, default_team: Team
) -> None:
    """A project-role change updates the team role but must not flip facets."""
    user = User.objects.create_user(username="sm", password="pw")
    TeamMembership.objects.create(
        team=default_team, user=user, role=TeamRole.MEMBER, is_scrum_master=True
    )

    ensure_team_membership(project_id=project.pk, user_id=user.pk, project_role=Role.ADMIN)

    tm = TeamMembership.objects.get(team=default_team, user=user)
    assert tm.role == TeamRole.ADMIN
    assert tm.is_scrum_master is True  # facet survived the role change


def test_membership_signal_mirrors_to_default_team(
    project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Creating a ProjectMembership mirrors onto the default team on commit (ADR-0078 §F)."""
    user = User.objects.create_user(username="newbie", password="pw")
    with django_capture_on_commit_callbacks(execute=True):
        ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)

    team = resolve_default_team(project.pk)
    assert team is not None
    assert TeamMembership.objects.filter(team=team, user=user, is_deleted=False).exists()
