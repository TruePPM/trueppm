"""Service layer for the teams app (ADR-0078 §Durable Execution §4).

Holds the default-team resolution, the auto-membership invariant, and the facet
resolution helpers that downstream gates (ADR-0104 signal privacy, ADR-0102 scope
injection, ADR-0073 capacity) call instead of re-implementing the lookup.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.contrib.auth.models import AbstractBaseUser, AnonymousUser
from django.db.models import Exists, OuterRef, Q

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

if TYPE_CHECKING:
    from collections.abc import Sequence

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


def facet_holder_user_ids(
    project_id: Any,
    *,
    facets: Sequence[str] = FACET_FIELDS,
    live_project_members_only: bool = True,
) -> set[Any]:
    """User ids holding a Scrum Master or Product Owner facet on the default team.

    The set-shaped counterpart to :func:`user_facets`: same table, same filters,
    asked of the *project* rather than of one user. Notification and digest cohorts
    need this shape — ``user_facets`` answers "does this person hold a facet", which
    cannot build a recipient list without iterating every member.

    It lives here, beside ``user_facets``, on purpose. #2897 happened because the
    two questions were answered in different files against different tables: the
    ADR-0102 scope gate authorized ADMIN+ ∪ SM ∪ PO from ``TeamMembership``, while
    the notification for that same event was built from ``ProjectMembership`` at
    ADMIN+ only. The facet holders the feature existed for were exactly the ones it
    never told. A recipient cohort that must match an authorization predicate should
    read the predicate's own source, not a lookalike.

    **The live-membership intersection defaults to on, and the default is the whole
    point (#3334).** The ADR-0078 §F mirror only ever *creates* team rows
    (:mod:`trueppm_api.apps.teams.signals` has no ``post_delete`` receiver and
    ``TeamMembership`` has no FK a cascade could travel over), so soft-deleting a
    ``ProjectMembership`` leaves the mirrored ``TeamMembership`` live with its facet
    flags intact. A cohort built from the team row alone therefore keeps naming a
    project's task names, sprint names and actors to someone who can no longer open
    it — a dead link and a scope leak (ADR-0104's back-door close: a non-member sits
    below every tier). That has now been fixed three times at three call sites
    (#2897, #3291, #3334), which is why the guard is here and defaulted **safe**
    rather than left for each new cohort to remember.

    Args:
        project_id: The project whose default team is read.
        facets: Which of :data:`FACET_FIELDS` count as holding. Defaults to both.
            ``("is_scrum_master",)`` is the impediment-clearer cohort, which routes
            to the SM only.
        live_project_members_only: Intersect with non-soft-deleted
            ``ProjectMembership`` on the same project. Pass ``False`` only when the
            caller has already read live membership and will intersect itself — the
            correlated subquery is redundant work in that case, not extra safety.

    Returns:
        The de-duplicated set of user ids holding at least one of ``facets``.

    Raises:
        ValueError: If ``facets`` is empty or names anything outside
            :data:`FACET_FIELDS`.
    """
    # Materialize before validating. The guard below and the Q-building loop each
    # consume `facets`, and a one-shot iterable would be drained by the first — which
    # fails *open*, not closed: the loop then builds a bare `Q()`, that matches every
    # row, and a facet cohort silently becomes the whole roster. The `Sequence`
    # annotation rules that out today; the tuple() makes it not depend on the
    # annotation.
    facets = tuple(facets)
    unknown = sorted(set(facets) - set(FACET_FIELDS))
    if not facets:
        raise ValueError(f"Unknown team facets: at least one of {list(FACET_FIELDS)} required")
    if unknown:
        raise ValueError(f"Unknown team facets: {unknown!r}")

    holds_a_facet = Q()
    for field in facets:
        holds_a_facet |= Q(**{field: True})

    queryset = TeamMembership.objects.filter(
        team__project_id=project_id,
        team__is_default=True,
        team__is_deleted=False,
        is_deleted=False,
    ).filter(holds_a_facet)

    if live_project_members_only:
        # Correlated on `team__project_id` rather than on the `project_id` argument
        # so the predicate stays correct if a caller ever widens the outer filter to
        # `project_id__in=(...)` for a batched fan-out (#3335) — the subquery then
        # still pairs each team row with its own project's membership.
        queryset = queryset.filter(
            Exists(
                ProjectMembership.objects.filter(
                    project_id=OuterRef("team__project_id"),
                    user_id=OuterRef("user_id"),
                    is_deleted=False,
                )
            )
        )

    return set(queryset.values_list("user_id", flat=True))


def facet_holder_user_ids_by_project(project_ids: Any) -> dict[Any, set[Any]]:
    """``{project_id: {user_id, ...}}`` for a whole set of projects in one query.

    The batch counterpart to :func:`facet_holder_user_ids`: same table, same
    filters, grouped by project rather than scoped to one. A fan-out that spans
    many projects — the program settings matrix applies one field map to as many
    as ``MAX_BULK_TARGETS`` of them — would otherwise repeat the identical team
    scan once per project inside its loop.

    Projects with no facet holder are simply absent from the mapping; callers
    read it with ``.get(pid, set())``. Keys come back as the ORM yields them
    (``uuid.UUID``), so a caller holding stringified ids must normalize.

    Liveness is the caller's, exactly as for :func:`facet_holder_user_ids`: this
    returns the raw facet roster, and a recipient cohort that must not name a
    member who has lost access intersects it with live ``ProjectMembership`` —
    see :func:`~trueppm_api.apps.projects.config_notice.surface_recipient_ids_by_project`,
    which does so from the membership map it already holds for its own cohorts.
    """
    holders: dict[Any, set[Any]] = {}
    for project_id, user_id in (
        TeamMembership.objects.filter(
            team__project_id__in=project_ids,
            team__is_default=True,
            team__is_deleted=False,
            is_deleted=False,
        )
        .filter(Q(is_scrum_master=True) | Q(is_product_owner=True))
        .values_list("team__project_id", "user_id")
    ):
        holders.setdefault(project_id, set()).add(user_id)
    return holders


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
