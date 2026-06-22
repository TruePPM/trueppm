"""Service layer for the teams app (ADR-0078 §Durable Execution §4).

Holds the default-team resolution, the auto-membership invariant, and the facet
resolution helpers that downstream gates (ADR-0104 signal privacy, ADR-0102 scope
injection, ADR-0073 capacity) call instead of re-implementing the lookup.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.contrib.auth.models import AbstractBaseUser, AnonymousUser

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project

# The two facet flags, exposed as a tuple so gates and serializers share one
# source of truth for "which booleans are facets" rather than hard-coding strings.
FACET_FIELDS = ("is_scrum_master", "is_product_owner")


def project_role_to_team_role(project_role: int) -> str:
    """Map a project ``Role`` ordinal to the coarse team role.

    Project Admin (300) and Owner (400) become team Admin per ADR-0078 §C step 3;
    everyone else is a team Member. Facets are never inferred — they default False
    and require explicit assignment.
    """
    return TeamRole.ADMIN if project_role >= Role.ADMIN else TeamRole.MEMBER


def resolve_default_team(project_id: Any) -> Team | None:
    """Return the project's default team, or None if it has not been created yet.

    The invariant (one default team per project, created at migration and by the
    auto-membership signal) means this is non-None for any real project, but
    callers tolerate None so a brand-new project mid-creation never 500s.
    """
    return Team.objects.filter(project_id=project_id, is_default=True, is_deleted=False).first()


def _get_or_create_default_team(project_id: Any, created_by: Any = None) -> Team:
    """Get-or-create the default team for a project id (idempotent, ADR-0078 §DE §7).

    Keyed on (project, is_default) so a concurrent create collapses to one row via
    the ``team_one_default_per_project`` constraint. Historical/migration rows and
    this path both stamp server_version=1 so the row is never left at 0.
    """
    team, _created = Team.objects.get_or_create(
        project_id=project_id,
        is_default=True,
        is_deleted=False,
        defaults={
            "name": "Default Team",
            "short_id": "T01",
            "created_by": created_by,
            "server_version": 1,
        },
    )
    return team


def ensure_default_team(project: Project, created_by: Any = None) -> Team:
    """Get-or-create the project's default team (idempotent, ADR-0078 §DE §7)."""
    return _get_or_create_default_team(project.pk, created_by=created_by)


def ensure_team_membership(*, project_id: Any, user_id: Any, project_role: int) -> None:
    """Mirror a project membership onto the project's default team (ADR-0078 §F).

    Permanent invariant, not a one-time migration: a new project member must
    appear on the default team automatically so the facet matrix is complete and
    nobody faces a second "join the team" step. The default team is created on
    demand (it exists for projects that predate this app via the data migration,
    and is materialized here for projects created afterward). The access role is
    mapped to the team role on every call so a project-role change keeps the team
    role in step, but the facets are left untouched — they are explicit,
    user-assigned markers that a role change must never silently flip.
    """
    team = _get_or_create_default_team(project_id)

    team_role = project_role_to_team_role(project_role)
    membership, created = TeamMembership.objects.get_or_create(
        team=team,
        user_id=user_id,
        is_deleted=False,
        defaults={"role": team_role},
    )
    if not created and membership.role != team_role:
        membership.role = team_role
        membership.save(update_fields=["role"])


def user_facets(user: AbstractBaseUser | AnonymousUser, project_id: Any) -> dict[str, bool]:
    """Resolve a user's facet flags on a project's default team.

    Returns ``{"is_scrum_master": bool, "is_product_owner": bool}`` — both False
    for an anonymous user, a non-member, or a project whose default team has no
    membership row for them. This is the single seam gates read.
    """
    if not getattr(user, "is_authenticated", False):
        return {"is_scrum_master": False, "is_product_owner": False}

    membership = (
        TeamMembership.objects.filter(
            team__project_id=project_id,
            team__is_default=True,
            team__is_deleted=False,
            user=user,  # type: ignore[misc]  # narrowed authenticated above
            is_deleted=False,
        )
        .values("is_scrum_master", "is_product_owner")
        .first()
    )
    if membership is None:
        return {"is_scrum_master": False, "is_product_owner": False}
    return {
        "is_scrum_master": bool(membership["is_scrum_master"]),
        "is_product_owner": bool(membership["is_product_owner"]),
    }


def has_team_facet(user: AbstractBaseUser | AnonymousUser, project_id: Any, facet: str) -> bool:
    """Whether ``user`` holds ``facet`` on the project's default team.

    ``facet`` is one of :data:`FACET_FIELDS`. This is the predicate gates call —
    e.g. "the requester is the Product Owner" for the ADR-0102 scope-injection
    accept gate — so the team lookup lives in one place rather than every viewset.
    """
    if facet not in FACET_FIELDS:
        raise ValueError(f"Unknown team facet: {facet!r}")
    return user_facets(user, project_id)[facet]


def team_member_user_ids(project_id: Any) -> set[Any]:
    """Return the set of user ids on a project's default team (the voter roster).

    The eligible-voter set for the ADR-0104 Amendment-A ceiling-raise ratification:
    every non-deleted ``TeamMembership`` of the project's default team. Scoped to
    *team* membership — **not** project membership — so a non-team project Admin/PM
    cannot vote on (or stuff) a team's signal-sharing decision. One query; the count
    is the ratification denominator and ``user_id in <set>`` is the per-voter gate.
    """
    return set(
        TeamMembership.objects.filter(
            team__project_id=project_id,
            team__is_default=True,
            team__is_deleted=False,
            is_deleted=False,
        ).values_list("user_id", flat=True)
    )


def is_team_member(user: AbstractBaseUser | AnonymousUser, project_id: Any) -> bool:
    """Whether ``user`` is on the project's default team (an eligible signal voter)."""
    if not getattr(user, "is_authenticated", False):
        return False
    return TeamMembership.objects.filter(
        team__project_id=project_id,
        team__is_default=True,
        team__is_deleted=False,
        user=user,  # type: ignore[misc]  # narrowed authenticated above
        is_deleted=False,
    ).exists()
