"""DRF permission classes for the teams app (ADR-0078 §D).

The 0.3 slice exposes only read and facet/role assignment, so it needs two gates:

* :class:`IsTeamMember` — any member of the team's project may read the roster.
* :class:`IsTeamFacetEditor` — role and facet assignment. Per the §D split this is
  a *low-consent* action, so it is the inheriting bucket: a project Admin (role ≥
  ADMIN) **or** an explicit ``TeamMembership(role='admin')`` may edit. The
  consent-sensitive actions (TeamInternalsOptIn, sprint rebind, bulk replace) that
  require explicit team-admin with no inheritance are out of scope until #599.
"""

from __future__ import annotations

from typing import Any

from rest_framework.permissions import SAFE_METHODS, BasePermission
from rest_framework.request import Request
from rest_framework.views import APIView

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import _membership_role
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole


def _team_pk_from_view(view: APIView) -> Any | None:
    """Extract the team pk from nested (``team_pk``) or detail (``pk``) routes."""
    kwargs = getattr(view, "kwargs", {})
    return kwargs.get("team_pk") or kwargs.get("pk")


def _project_id_for_team(request: Request, team_id: Any) -> Any | None:
    """Resolve (and per-request cache) the project a team belongs to."""
    cache: dict[Any, Any | None] | None = getattr(request, "_team_project_cache", None)
    if cache is None:
        cache = {}
        request._team_project_cache = cache  # type: ignore[attr-defined]
    if team_id in cache:
        return cache[team_id]
    project_id = (
        Team.objects.filter(pk=team_id, is_deleted=False)
        .values_list("project_id", flat=True)
        .first()
    )
    cache[team_id] = project_id
    return project_id


def _team_role(request: Request, team_id: Any) -> str | None:
    """Return the requester's explicit team role on ``team_id``, or None."""
    if not (request.user and request.user.is_authenticated):
        return None
    return (
        TeamMembership.objects.filter(team_id=team_id, user=request.user, is_deleted=False)
        .values_list("role", flat=True)
        .first()
    )


def _route_project_id(request: Request, view: APIView) -> Any | None:
    """Resolve the project a request targets, from either route shape.

    The project-scoped list route carries ``project_pk`` directly; the team and
    member routes carry ``team_pk`` / ``pk`` and resolve the project through the
    team. Returns None when neither is present or the team does not exist —
    callers fail closed on None so an unrecognized route never default-allows.
    """
    project_pk = getattr(view, "kwargs", {}).get("project_pk")
    if project_pk is not None:
        return project_pk
    team_id = _team_pk_from_view(view)
    if team_id is None:
        return None
    return _project_id_for_team(request, team_id)


def _can_edit_facets(request: Request, team_id: Any) -> bool:
    """Project Admin (inheritance) OR explicit team Admin (ADR-0078 §D low-consent)."""
    project_id = _project_id_for_team(request, team_id)
    if project_id is None:
        return False
    project_role = _membership_role(request, project_id)
    if project_role is not None and project_role >= Role.ADMIN:
        return True
    return _team_role(request, team_id) == TeamRole.ADMIN


class IsTeamMember(BasePermission):
    """Any member of the team's project may read the team and its roster.

    Fails closed: the project-scoped list route (``project_pk``, no ``team_pk``)
    must still require project membership, so the queryset filter is never the
    sole scoping (prevents the cross-project enumeration IDOR class of #887).
    """

    message = "You must be a member of this team's project."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        project_id = _route_project_id(request, view)
        if project_id is None:
            return False
        return _membership_role(request, project_id) is not None

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        project_id = getattr(obj, "project_id", None)
        if project_id is None:
            return False
        return _membership_role(request, project_id) is not None


class IsTeamFacetEditor(BasePermission):
    """Read for any project member; role/facet writes for project Admin or team Admin."""

    message = "You need Project Manager or team Admin to change team roles or facets."

    def has_permission(self, request: Request, view: APIView) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        project_id = _route_project_id(request, view)
        if project_id is None:
            return False
        if _membership_role(request, project_id) is None:
            return False
        if request.method in SAFE_METHODS:
            return True
        team_id = _team_pk_from_view(view)
        return team_id is not None and _can_edit_facets(request, team_id)

    def has_object_permission(self, request: Request, view: APIView, obj: Any) -> bool:
        """Defense-in-depth: re-derive edit rights from the object's own team.

        The roster queryset already scopes to ``team_pk``, but checking the
        object's team directly means a future non-nested route cannot become a
        cross-team write IDOR by relying on the route param alone.
        """
        if request.method in SAFE_METHODS:
            project_id = getattr(obj, "project_id", None)
            return project_id is not None and _membership_role(request, project_id) is not None
        return _can_edit_facets(request, obj.team_id)
