"""URL routing for the teams app (ADR-0078 §E).

0.3 slice surface only: list a project's teams, retrieve one, list a team's
roster, and PATCH a member's role/facets. Create/delete of teams and members,
the activity feed, and the TeamInternalsOptIn toggle land with #599.
"""

from __future__ import annotations

from django.urls import path

from trueppm_api.apps.teams.views import TeamMembershipViewSet, TeamViewSet

_teams = TeamViewSet.as_view({"get": "list"})
_team_detail = TeamViewSet.as_view({"get": "retrieve"})
_members = TeamMembershipViewSet.as_view({"get": "list"})
_member_detail = TeamMembershipViewSet.as_view({"patch": "partial_update"})

urlpatterns = [
    path(
        "projects/<uuid:project_pk>/teams/",
        _teams,
        name="project-teams-list",
    ),
    path(
        "teams/<uuid:pk>/",
        _team_detail,
        name="team-detail",
    ),
    path(
        "teams/<uuid:team_pk>/members/",
        _members,
        name="team-members-list",
    ),
    path(
        "teams/<uuid:team_pk>/members/<uuid:pk>/",
        _member_detail,
        name="team-members-detail",
    ),
]
