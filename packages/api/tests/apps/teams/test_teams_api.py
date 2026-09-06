"""Team roster + facet assignment API tests (ADR-0078 §E, #927)."""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole
from trueppm_api.apps.teams.permissions import IsTeamMember

User = get_user_model()

pytestmark = pytest.mark.django_db


def _members_url(team: Team) -> str:
    return f"/api/v1/teams/{team.pk}/members/"


def _member_url(team: Team, membership: TeamMembership) -> str:
    return f"/api/v1/teams/{team.pk}/members/{membership.pk}/"


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


def test_project_teams_list_returns_default_team(
    admin_client: APIClient, project: Any, default_team: Team, team_members: dict[str, Any]
) -> None:
    resp = admin_client.get(f"/api/v1/projects/{project.pk}/teams/")
    assert resp.status_code == 200
    rows = resp.data["results"]  # paginated (#1317)
    assert len(rows) == 1
    assert rows[0]["is_default"] is True
    assert rows[0]["member_count"] == 4


def test_roster_lists_members_with_facets(
    admin_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    resp = admin_client.get(_members_url(default_team))
    assert resp.status_code == 200
    rows = resp.data["results"]  # paginated (#1317)
    assert len(rows) == 4
    row = next(r for r in rows if r["role"] == TeamRole.ADMIN)
    assert {"is_scrum_master", "is_product_owner", "role_label", "user_detail"} <= row.keys()


def test_roster_list_is_paginated(
    admin_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    """A 200-member roster returns a single bounded page (#1317).

    Page-number pagination (not cursor) is retained for the roster, so ``count``
    stays available for any future "N members" header.
    """
    extra = User.objects.bulk_create([User(username=f"tm{i:04d}") for i in range(200)])
    TeamMembership.objects.bulk_create(
        [TeamMembership(team=default_team, user=u, role=TeamRole.MEMBER) for u in extra]
    )
    resp = admin_client.get(_members_url(default_team))
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 50  # PageNumberPagination default page_size
    assert resp.data["count"] >= 200
    assert resp.data["next"] is not None


def test_outsider_cannot_read_roster(
    outsider_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    resp = outsider_client.get(_members_url(default_team))
    assert resp.status_code == 403


def test_team_list_query_count_does_not_scale_with_teams(
    admin_client: APIClient,
    project: Any,
    default_team: Team,
    team_members: dict[str, Any],
    django_assert_max_num_queries: Any,
) -> None:
    """``member_count`` must come from the queryset annotation, not a per-row COUNT.

    ``TeamSerializer.get_member_count`` falls back to ``obj.memberships.filter(...).count()``
    when the annotation is absent, so dropping ``member_count_annotated`` from
    ``TeamViewSet.get_queryset`` would degrade the list to one extra query per team with
    every other assertion in this file still passing.

    The annotated list costs 5 queries regardless of row count; the budget is 7 so that
    the fallback's three extra COUNTs (one per team here) breach it while leaving room
    for an unrelated query to be added later.
    """
    for n in (2, 3):
        Team.objects.create(project=project, name=f"Team {n}", short_id=f"T0{n}")

    with django_assert_max_num_queries(7):
        resp = admin_client.get(f"/api/v1/projects/{project.pk}/teams/")
    assert resp.status_code == 200
    rows = resp.data["results"]
    assert len(rows) == 3
    assert sorted(r["member_count"] for r in rows) == [0, 0, 4]


def test_outsider_cannot_list_project_teams(
    outsider_client: APIClient, project: Any, default_team: Team, team_members: dict[str, Any]
) -> None:
    """Cross-project enumeration IDOR guard: non-members get 403 on the team list."""
    resp = outsider_client.get(f"/api/v1/projects/{project.pk}/teams/")
    assert resp.status_code == 403


def test_is_team_member_object_gate_admits_a_member_and_refuses_an_outsider(
    rf: Any, member: Any, outsider: Any, default_team: Team, memberships: None
) -> None:
    """``IsTeamMember.has_object_permission``, exercised directly.

    No route reaches it since the team detail route was removed (#3370), but #599
    restores detail/PATCH/DELETE onto this class. Testing the method rather than a
    route keeps the object-level gate proven while it has no caller.
    """
    # A fresh request per subject: ``_membership_role`` memoizes on the request, so
    # swapping ``.user`` on one request would serve the first subject's answer to the
    # second — and the outsider assertion would pass vacuously.
    member_request = rf.get("/")
    member_request.user = member
    assert IsTeamMember().has_object_permission(member_request, None, default_team) is True

    outsider_request = rf.get("/")
    outsider_request.user = outsider
    assert IsTeamMember().has_object_permission(outsider_request, None, default_team) is False


def test_is_team_member_object_gate_fails_closed_on_an_object_with_no_project(
    rf: Any, member: Any
) -> None:
    """A non-project object must be refused, never default-allowed."""
    request = rf.get("/")
    request.user = member
    assert IsTeamMember().has_object_permission(request, None, object()) is False


# ---------------------------------------------------------------------------
# Facet assignment
# ---------------------------------------------------------------------------


def test_admin_assigns_scrum_master_facet(
    admin_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    target = team_members["member"]
    resp = admin_client.patch(_member_url(default_team, target), {"is_scrum_master": True})
    assert resp.status_code == 200
    assert resp.data["is_scrum_master"] is True
    target.refresh_from_db()
    assert target.is_scrum_master is True
    # Role is untouched by a facet flip — the axes are independent.
    assert target.role == TeamRole.MEMBER


def test_facets_are_independent_of_role(
    admin_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    """A Member can be Product Owner; an Admin need not hold any facet."""
    target = team_members["member"]
    resp = admin_client.patch(_member_url(default_team, target), {"is_product_owner": True})
    assert resp.status_code == 200
    target.refresh_from_db()
    assert target.is_product_owner is True
    assert target.role == TeamRole.MEMBER


def test_setting_scrum_master_reassigns_from_prior_holder(
    admin_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    """Soft-singleton: assigning SM to a second member clears the first (reassign)."""
    first = team_members["member"]
    second = team_members["viewer"]
    first.is_scrum_master = True
    first.save(update_fields=["is_scrum_master"])

    resp = admin_client.patch(_member_url(default_team, second), {"is_scrum_master": True})
    assert resp.status_code == 200

    first.refresh_from_db()
    second.refresh_from_db()
    assert second.is_scrum_master is True
    assert first.is_scrum_master is False
    # Exactly one Scrum Master on the team.
    assert (
        TeamMembership.objects.filter(
            team=default_team, is_scrum_master=True, is_deleted=False
        ).count()
        == 1
    )


def test_product_owner_reassign_does_not_touch_scrum_master(
    admin_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    """Reassigning one facet leaves the other facet's holder alone."""
    sm = team_members["member"]
    sm.is_scrum_master = True
    sm.save(update_fields=["is_scrum_master"])
    po_first = team_members["owner"]
    po_first.is_product_owner = True
    po_first.save(update_fields=["is_product_owner"])

    resp = admin_client.patch(
        _member_url(default_team, team_members["viewer"]), {"is_product_owner": True}
    )
    assert resp.status_code == 200

    sm.refresh_from_db()
    po_first.refresh_from_db()
    assert sm.is_scrum_master is True  # untouched
    assert po_first.is_product_owner is False  # reassigned away


def test_toggling_facet_off_leaves_it_vacant(
    admin_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    holder = team_members["member"]
    holder.is_scrum_master = True
    holder.save(update_fields=["is_scrum_master"])

    resp = admin_client.patch(_member_url(default_team, holder), {"is_scrum_master": False})
    assert resp.status_code == 200
    holder.refresh_from_db()
    assert holder.is_scrum_master is False
    assert not TeamMembership.objects.filter(
        team=default_team, is_scrum_master=True, is_deleted=False
    ).exists()


def test_role_change(
    admin_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    target = team_members["member"]
    resp = admin_client.patch(_member_url(default_team, target), {"role": TeamRole.ADMIN})
    assert resp.status_code == 200
    target.refresh_from_db()
    assert target.role == TeamRole.ADMIN


# ---------------------------------------------------------------------------
# Permissions (ADR-0078 §D low-consent split)
# ---------------------------------------------------------------------------


def test_project_admin_inherits_facet_edit(
    admin_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    """Project Admin (role >= 300) may edit facets without an explicit team-admin row."""
    # project_admin is a team *member*-role row, but project role is ADMIN.
    team_members["project_admin"].role = TeamRole.MEMBER
    team_members["project_admin"].save(update_fields=["role"])
    resp = admin_client.patch(
        _member_url(default_team, team_members["member"]), {"is_scrum_master": True}
    )
    assert resp.status_code == 200


def test_explicit_team_admin_can_edit_facets(
    default_team: Team, team_members: dict[str, Any], member: Any
) -> None:
    """A project Member who is team Admin may edit facets."""
    tm = team_members["member"]
    tm.role = TeamRole.ADMIN
    tm.save(update_fields=["role"])
    client = APIClient()
    client.force_authenticate(user=member)
    resp = client.patch(
        _member_url(default_team, team_members["viewer"]), {"is_product_owner": True}
    )
    assert resp.status_code == 200


def test_plain_member_cannot_edit_facets(
    member_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    """A project Member who is only a team Member is read-only on facets."""
    resp = member_client.patch(
        _member_url(default_team, team_members["viewer"]), {"is_scrum_master": True}
    )
    assert resp.status_code == 403


def test_viewer_cannot_edit_facets(
    viewer_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    resp = viewer_client.patch(
        _member_url(default_team, team_members["member"]), {"is_scrum_master": True}
    )
    assert resp.status_code == 403


def test_outsider_cannot_edit_facets(
    outsider_client: APIClient, default_team: Team, team_members: dict[str, Any]
) -> None:
    resp = outsider_client.patch(
        _member_url(default_team, team_members["member"]), {"is_scrum_master": True}
    )
    assert resp.status_code == 403
