"""Facet-resolution helpers and the auto-membership invariant (ADR-0078, #927).

These cover the seam downstream gates (ADR-0104 signal privacy, ADR-0102 scope
injection) read: ``has_team_facet`` / ``user_facets``. The headline assertion is
that an *admin without the facet* does NOT pass the facet gate — role and facet
are independent axes.
"""

from __future__ import annotations

import inspect
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


def _project_member(project: Project, username: str, role: int = Role.MEMBER) -> Any:
    """A user seated on ``project`` — the precondition for holding a team facet.

    In production a ``TeamMembership`` exists only because the ADR-0078 §F mirror made
    one from a ``ProjectMembership``, so a fixture that creates the team row alone
    describes a state only a revocation can produce.
    """
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


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

    Every subject is given a live ``ProjectMembership`` because that is the only way a
    ``TeamMembership`` comes to exist in production — the ADR-0078 §F mirror creates it
    from one. The helper's live-membership intersection (#3334) is therefore satisfied
    for all of them, and this test stays a statement about the facet correspondence
    rather than about the liveness filter, which
    ``test_facet_holder_user_ids_excludes_a_revoked_project_member`` owns.
    """
    sm = _project_member(project, "sm")
    po = _project_member(project, "po2")
    both = _project_member(project, "both")
    neither = _project_member(project, "neither")
    admin_no_facet = _project_member(project, "admin-nf")

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


def test_the_two_facet_seams_on_a_revoked_holder(project: Project, default_team: Team) -> None:
    """Pins both seams' answer for a revoked facet holder, in either merge order.

    The equality test above was made to keep passing by giving every fixture user a
    live ``ProjectMembership`` — correct, because a team row without one is a state
    only a revocation produces. But that edit means it now only ever asks the *live*
    cohort, and the divergence it was written to catch (#2897: two seams answering the
    same question differently) moved out of its view. So the revoked cohort is asserted
    here instead of being fixtured away.

    The awkward part is that the two seams are mid-migration and land in separate MRs:
    #3386 floors ``user_facets``, #3334 floors ``facet_holder_user_ids``. A test that
    hard-coded either state would be green on its own branch and red on ``main`` the
    moment the other merged — a collision that exists only on the merged tree, which is
    the failure mode worth designing out rather than leaving a note about. So the
    expectation is **derived from the resolver's own signature**: once
    ``facet_holder_user_ids`` grows the floor parameter, this asserts the floored
    answer; until then it asserts the un-floored one. Either way ``user_facets``
    excludes the revoked holder, which is the invariant #3386 actually owns.
    """
    revoked = User.objects.create_user(username="diverge", password="pw")
    membership = ProjectMembership.objects.create(project=project, user=revoked, role=Role.MEMBER)
    TeamMembership.objects.create(team=default_team, user=revoked, is_product_owner=True)
    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    # The invariant this branch owns, true in both worlds.
    assert user_facets(revoked, project.pk)["is_product_owner"] is False

    set_seam_is_floored = (
        "live_project_members_only" in inspect.signature(facet_holder_user_ids).parameters
    )
    if set_seam_is_floored:
        assert revoked.pk not in facet_holder_user_ids(project.pk)
    else:
        assert revoked.pk in facet_holder_user_ids(project.pk)


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


def test_user_facets_floors_on_live_project_membership(
    project: Project, default_team: Team
) -> None:
    """A revoked project member's residual facet row resolves to no facets (#3386).

    The ADR-0078 §F mirror is create-only, so soft-deleting the ``ProjectMembership``
    leaves this ``TeamMembership`` live and flagged. Four write gates read this seam on
    the branch that runs precisely when the role lookup returned ``None``, so without
    the floor the revocation would *promote* the residual facet into the user's only
    credential. The full gate-by-gate sweep lives in
    ``tests/apps/access/test_facet_live_membership_floor.py``; this asserts the seam.
    """
    user = User.objects.create_user(username="revoked-po", password="pw")
    membership = ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    TeamMembership.objects.create(
        team=default_team, user=user, role=TeamRole.MEMBER, is_product_owner=True
    )
    assert has_team_facet(user, project.pk, "is_product_owner") is True  # control: live member

    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    assert has_team_facet(user, project.pk, "is_product_owner") is False
    assert user_facets(user, project.pk) == {"is_scrum_master": False, "is_product_owner": False}
    # The opt-out still answers the raw "what does the team row say" question.
    raw = user_facets(user, project.pk, live_project_members_only=False)
    assert raw["is_product_owner"] is True


def test_facet_holder_user_ids_excludes_a_revoked_project_member(
    project: Project, default_team: Team
) -> None:
    """A live team row whose *project* membership was revoked contributes nobody (#3334).

    This is the state the ADR-0078 §F mirror produces on every offboarding: it has no
    ``post_delete`` receiver and ``TeamMembership`` has no FK a cascade could travel
    over, so revoking the project membership leaves the team row untouched with its
    facet flags set. The team-row filters cannot see it — only the project-row
    intersection can, which is why the default is on.
    """
    gone = _project_member(project, "ex-po")
    TeamMembership.objects.create(team=default_team, user=gone, is_product_owner=True)
    ProjectMembership.objects.filter(project=project, user=gone).update(is_deleted=True)

    # The precondition the bug depends on: the mirrored row is still live.
    assert TeamMembership.objects.filter(user=gone, is_deleted=False).exists()

    assert facet_holder_user_ids(project.pk) == set()
    # The opt-out still sees them — it is the pre-#3334 team-scoped question, which is
    # only safe for a caller that intersects live membership itself.
    assert facet_holder_user_ids(project.pk, live_project_members_only=False) == {gone.pk}


def test_facet_holder_user_ids_can_be_restricted_to_one_facet(
    project: Project, default_team: Team
) -> None:
    """``facets=`` narrows the cohort — the impediment resolver routes to the SM only."""
    sm = _project_member(project, "sm-only")
    po = _project_member(project, "po-only")
    TeamMembership.objects.create(team=default_team, user=sm, is_scrum_master=True)
    TeamMembership.objects.create(team=default_team, user=po, is_product_owner=True)

    assert facet_holder_user_ids(project.pk, facets=("is_scrum_master",)) == {sm.pk}
    assert facet_holder_user_ids(project.pk, facets=("is_product_owner",)) == {po.pk}
    assert facet_holder_user_ids(project.pk) == {sm.pk, po.pk}


@pytest.mark.parametrize("facets", [("is_tester",), ()])
def test_facet_holder_user_ids_rejects_unknown_or_empty_facets(
    project: Project, default_team: Team, facets: tuple[str, ...]
) -> None:
    """An unrecognized or empty ``facets=`` fails loud rather than matching everyone.

    An empty tuple would build an empty ``Q()``, which matches every row — silently
    turning a facet cohort into the whole roster. ``has_team_facet`` raises on an
    unknown facet for the same reason; this keeps the two seams consistent.
    """
    with pytest.raises(ValueError, match="Unknown team facets"):
        facet_holder_user_ids(project.pk, facets=facets)


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
