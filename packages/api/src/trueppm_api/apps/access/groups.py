"""Auto-group resolver for @mention fan-out (ADR-0075 §C).

Resolves auto-group keys to a list of user IDs at the moment of write. The
resolver is intentionally snapshot-based: new members joining after a
mention do NOT receive retroactive notifications, and departed members are
not re-pinged. This matches Slack / GitHub / Jira semantics.

Auto-groups (0.2):
    @owners       Project members with Owner role
    @admins       Project members with Admin OR Owner role
    @schedulers   Project members with Scheduler+ role
    @members      Project members with Member role
    @viewers      Project members with Viewer role
    @all          Every project member
    @scrum-team   Members assigned to tasks in the active sprint(s)

ADR-0075 locked constraints enforced by this module:
    @all cardinality cap: 200 (raises GroupTooLargeError above)
    @all role gate:       ADMIN+ (enforced by the parser, not this module)

Program auto-groups (#514, ADR-0075 §C extension):
    @program-pms          Owner/Admin across every project in the mention's program
    @program-schedulers   Scheduler+ across the program
    @program-stakeholders Viewer-role (exact) across the program
    @program-all          Every member of every project in the program

Program groups resolve against the program that contains the project the
mention was written in (``Project.program``). They draw from the UNION of
``ProjectMembership`` across the program's projects — the people actually
working the program's projects — not from program-level ``ProgramMembership``.

User-defined groups (#515, ADR-0212) are curated per project and resolved by
the separate ``resolve_user_defined_group_members`` path below — distinct from
the RBAC-derived auto-groups above.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any, NamedTuple, cast

if TYPE_CHECKING:
    from collections.abc import Iterable

    from django.db.models import QuerySet

    from trueppm_api.apps.access.models import ExternalStakeholder, ProjectMembership

# ADR-0075 locked constraint #1 — @all resolve cardinality cap.
ALL_GROUP_HARD_CAP: int = 200

# Project-scoped auto-group keys recognized since 0.2.
KNOWN_GROUP_KEYS: frozenset[str] = frozenset(
    {
        "owners",
        "admins",
        "schedulers",
        "members",
        "viewers",
        "all",
        "scrum-team",
    }
)

# Program-scoped auto-group keys (#514). Resolved from the union of
# ``ProjectMembership`` across every project in the mention's program.
PROGRAM_GROUP_KEYS: frozenset[str] = frozenset(
    {
        "program-pms",
        "program-schedulers",
        "program-stakeholders",
        "program-all",
    }
)

# Every recognized auto-group key (project + program scope). The mention parser
# classifies a ``@name`` as a group when it is in this set, and the user-defined
# group validator reserves the whole set so a curated group can never shadow an
# auto-group.
ALL_AUTO_GROUP_KEYS: frozenset[str] = KNOWN_GROUP_KEYS | PROGRAM_GROUP_KEYS


class InvalidGroupKeyError(ValueError):
    """Raised when a @mention references an unknown group key."""


class GroupTooLargeError(ValueError):
    """Raised when a @all resolution exceeds ALL_GROUP_HARD_CAP.

    The mention parser surfaces this to the user as a structured 400 with
    a friendly message ("@all would notify {n} people — limit is 200").
    """

    def __init__(self, key: str, count: int, cap: int = ALL_GROUP_HARD_CAP) -> None:
        super().__init__(
            f"@{key} resolves to {count} users; cap is {cap}. "
            "Use a smaller group or split the message."
        )
        self.key = key
        self.count = count
        self.cap = cap


def resolve_group_members(
    project_id: uuid.UUID | str,
    group_key: str,
) -> list[uuid.UUID]:
    """Snapshot-resolve an auto-group key to a list of user UUIDs.

    Inputs are validated; output is deduplicated.

    Raises:
        InvalidGroupKeyError: group_key is not in ALL_AUTO_GROUP_KEYS, or a
            ``@program-*`` key was used on a standalone project (no program).
        GroupTooLargeError:   @all / @program-all expands to more than
            ALL_GROUP_HARD_CAP users
    """
    # Local imports to avoid app-loading ordering surprises during AppConfig
    # ready() — resolver is only ever called from request paths.
    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.projects.models import Sprint, SprintState, Task

    key = group_key.strip().lower()
    if key not in ALL_AUTO_GROUP_KEYS:
        raise InvalidGroupKeyError(group_key)

    # Program-scoped groups (#514) fan out across the mention's whole program;
    # they resolve differently (join through Project.program) so branch early.
    if key in PROGRAM_GROUP_KEYS:
        return _resolve_program_group_members(project_id, key)

    # Role-bounded groups. Each "bucket" returns members at or above the
    # named role floor (band-boundary semantics per ADR-0072). E.g. @admins
    # includes OWNER; @schedulers includes ADMIN and OWNER.
    role_floors: dict[str, int] = {
        "owners": Role.OWNER,
        "admins": Role.ADMIN,
        "schedulers": Role.SCHEDULER,
        "members": Role.MEMBER,
        "viewers": Role.VIEWER,
    }
    # django-stubs infers values_list("user_id", flat=True) as int even when
    # the underlying field is UUID; cast at the boundary to satisfy mypy
    # without polluting the call sites.
    if key in role_floors:
        rows = list(
            ProjectMembership.objects.filter(
                project_id=project_id,
                role__gte=role_floors[key],
                is_deleted=False,
            )
            .values_list("user_id", flat=True)
            .distinct()
        )
        return cast(list[uuid.UUID], list(dict.fromkeys(rows)))

    if key == "all":
        rows = list(
            ProjectMembership.objects.filter(project_id=project_id, is_deleted=False)
            .values_list("user_id", flat=True)
            .distinct()
        )
        result = cast(list[uuid.UUID], list(dict.fromkeys(rows)))
        if len(result) > ALL_GROUP_HARD_CAP:
            raise GroupTooLargeError(key, len(result))
        return result

    if key == "scrum-team":
        active_sprint_ids = list(
            Sprint.objects.filter(
                project_id=project_id,
                state=SprintState.ACTIVE,
                is_deleted=False,
            ).values_list("id", flat=True)
        )
        scrum_rows = list(
            Task.objects.filter(
                project_id=project_id,
                is_deleted=False,
                assignee__isnull=False,
                sprint_id__in=active_sprint_ids,
            )
            .values_list("assignee_id", flat=True)
            .distinct()
        )
        return cast(list[uuid.UUID], list(dict.fromkeys(scrum_rows)))

    # Unreachable — ALL_AUTO_GROUP_KEYS membership was checked above and program
    # keys were dispatched earlier.
    raise InvalidGroupKeyError(group_key)  # pragma: no cover


def _program_membership_base_qs(
    program_id: uuid.UUID | str,
) -> QuerySet[ProjectMembership]:
    """Every live ``ProjectMembership`` across a program's live projects.

    The one base every ``@program-*`` key narrows, and the one the reach counter
    narrows too. It exists so a recipient-narrowing filter added here — excluding
    deactivated users, a privacy suppression gate — cannot be inherited by three of
    the four group keys and silently skipped by the fourth. Add such filters
    **here**, never in a per-key branch.
    """
    from trueppm_api.apps.access.models import ProjectMembership

    return ProjectMembership.objects.filter(
        project__program_id=program_id,
        project__is_deleted=False,
        is_deleted=False,
    )


def _program_stakeholder_membership_qs(
    program_id: uuid.UUID | str,
) -> QuerySet[ProjectMembership]:
    """The ``ProjectMembership`` rows the ``@program-stakeholders`` alias draws on.

    Narrows :func:`_program_membership_base_qs` to an **exact** ``Role.VIEWER`` —
    not the ``role__gte`` floor the project-level ``@viewers`` uses, which would
    resolve to everyone (Viewer is the lowest band) and duplicate ``@program-all``.

    Extracted so the resolver and the reach counter (ADR-0697) cannot drift: a
    change to the role band or the soft-delete rules moves both at once.

    Note the rows are per-(user, project): a person who is a Viewer on two projects
    in the program has two rows but is **one** recipient. Callers must dedupe on
    ``user_id`` — the resolver does, and so does the counter.
    """
    from trueppm_api.apps.access.models import Role

    return _program_membership_base_qs(program_id).filter(role=Role.VIEWER)


def _program_external_stakeholder_qs(
    program_id: uuid.UUID | str,
) -> QuerySet[ExternalStakeholder]:
    """The ``ExternalStakeholder`` rows registered against a program.

    The non-account arm of the ``@program-stakeholders`` fan-out. Extracted
    alongside :func:`_program_stakeholder_membership_qs` so the resolver and the
    reach counter share one definition (ADR-0697).
    """
    from trueppm_api.apps.access.models import ExternalStakeholder

    return ExternalStakeholder.objects.filter(program_id=program_id, is_deleted=False)


class ProgramStakeholderReach(NamedTuple):
    """The two arms of ``@program-stakeholders``, counted separately (ADR-0697).

    Deliberately **not** summable into a headline total: the two arms have
    materially different fates today. ``viewer_member_count`` people receive a
    durable in-app notification; ``external_stakeholder_count`` people receive
    nothing at all — they have no ``User`` account and outbound delivery is
    deferred to #1675. A combined number would re-introduce in the UI the same
    union the resolver was changed to stop making.
    """

    viewer_member_count: int
    external_stakeholder_count: int


def count_program_stakeholder_reach(
    program_id: uuid.UUID | str,
    exclude_project_ids: Iterable[uuid.UUID] | QuerySet[Any] | None = None,
) -> ProgramStakeholderReach:
    """Count both arms of ``@program-stakeholders`` for a program (ADR-0697).

    Backs ``GET /api/v1/programs/{id}/mention-reach/``. Shares its querysets with
    :func:`_resolve_program_group_members` and :func:`resolve_external_stakeholders`
    so the number a PM reads on the settings page is the number the mention will
    actually fan out to.

    Args:
        program_id: The program whose alias is being counted.
        exclude_project_ids: Projects to drop from the internal arm — the MCP
            team opt-out intersection (ADR-0678 T1). ``None`` for a human caller,
            which is the common case and leaves the query plan untouched. The
            external arm is program-owned with no project FK, so it is never
            narrowed by a project-level opt-out.

    Returns:
        A :class:`ProgramStakeholderReach` with the two arms counted separately.
    """
    memberships = _program_stakeholder_membership_qs(program_id)
    if exclude_project_ids is not None:
        memberships = memberships.exclude(project_id__in=exclude_project_ids)
    # Distinct on ``user_id``, never ``.count()`` on the membership rows: a Viewer
    # on two projects in the program is one recipient, and the resolver this
    # mirrors returns distinct users.
    return ProgramStakeholderReach(
        viewer_member_count=memberships.values("user_id").distinct().count(),
        external_stakeholder_count=_program_external_stakeholder_qs(program_id).count(),
    )


def _resolve_program_group_members(
    project_id: uuid.UUID | str,
    key: str,
) -> list[uuid.UUID]:
    """Snapshot-resolve a ``@program-*`` key to member UUIDs across the program.

    The mention was written on a task in ``project_id``; the group resolves to
    the program that contains that project (``Project.program``). Membership is
    the *union* of ``ProjectMembership`` across every live project in the
    program, filtered by the role band the key names, deduplicated across
    projects.

    Raises:
        InvalidGroupKeyError: the project is standalone (``program`` is NULL),
            so there is no program to resolve against. The autocomplete never
            offers ``@program-*`` for a standalone project; this only fires on a
            hand-typed key, and surfaces to the caller as a skipped group.
        GroupTooLargeError: ``@program-all`` exceeds ``ALL_GROUP_HARD_CAP`` — a
            program-wide fan-out is exactly the blast radius ADR-0075 caps.
    """
    from trueppm_api.apps.access.models import Role
    from trueppm_api.apps.projects.models import Project

    program_id = Project.objects.filter(pk=project_id).values_list("program_id", flat=True).first()
    if program_id is None:
        raise InvalidGroupKeyError(f"{key} (project has no program)")

    # Join through the sibling projects in one query rather than materializing
    # their ids first — bounded by (# projects in program × members), no N+1.
    # Exclude soft-deleted sibling projects and soft-deleted memberships.
    memberships = _program_membership_base_qs(program_id)
    if key == "program-pms":
        memberships = memberships.filter(role__gte=Role.ADMIN)
    elif key == "program-schedulers":
        memberships = memberships.filter(role__gte=Role.SCHEDULER)
    elif key == "program-stakeholders":
        # Stakeholders are the view-only audience — an EXACT Viewer role, not the
        # role>=VIEWER floor project-level @viewers uses (which, since Viewer is
        # the lowest band, would resolve to everyone and duplicate @program-all).
        # The AC's "+ external stakeholder list" is resolved separately and
        # additively by ``resolve_external_stakeholders`` (#1658, ADR-0264) — those
        # rows have no User account, so they are never unioned into this User-keyed
        # result; the caller threads them onto a distinct ``external_targets`` field.
        # Narrows the SAME base the other keys narrow — the extracted helper is a
        # composition of it, not a replacement — so a future base-level recipient
        # filter cannot be inherited by three keys and skipped by this one, and the
        # reach counter behind ``/mention-reach/`` stays in lockstep (ADR-0697).
        memberships = memberships.filter(role=Role.VIEWER)
    # program-all: no role filter — every member of every project in the program.

    rows = list(memberships.values_list("user_id", flat=True).distinct())
    result = cast(list[uuid.UUID], list(dict.fromkeys(rows)))
    if key == "program-all" and len(result) > ALL_GROUP_HARD_CAP:
        raise GroupTooLargeError(key, len(result))
    return result


def resolve_external_stakeholders(
    project_id: uuid.UUID | str,
) -> list[ExternalStakeholder]:
    """Snapshot-resolve the external stakeholders reachable from a project's program.

    The non-account arm of the ``@program-stakeholders`` fan-out (#1658, ADR-0264).
    The mention was written on a task in ``project_id``; this resolves the program
    that contains that project (``Project.program``) and returns that program's
    live :class:`~trueppm_api.apps.access.models.ExternalStakeholder` rows.

    These rows have **no** ``User`` account, so they are deliberately *additive and
    separate* from :func:`resolve_group_members` — never unioned into the
    User-keyed group result. The caller threads them onto a distinct
    ``external_targets`` field. Snapshot semantics match the auto-group resolvers:
    the list is the registry *at the moment of the mention*.

    Args:
        project_id: The project the mention was written in.

    Returns:
        The program's non-deleted external stakeholders, ordered by name. Empty for
        a standalone project (no program) — there is no program registry to draw on.
    """
    from trueppm_api.apps.projects.models import Project

    program_id = Project.objects.filter(pk=project_id).values_list("program_id", flat=True).first()
    if program_id is None:
        return []
    # Shares its queryset with the reach counter (ADR-0697) so the registry the PM
    # is shown a count of is exactly the registry a mention resolves against.
    return list(_program_external_stakeholder_qs(program_id).order_by("name", "email"))


def resolve_user_defined_group_members(
    project_id: uuid.UUID | str,
    name: str,
) -> list[uuid.UUID] | None:
    """Snapshot-resolve a user-defined group name to its member user UUIDs.

    The "separate resolver path" this module's header defers to #515 (ADR-0212).
    Distinct from :func:`resolve_group_members`, which resolves the RBAC-derived
    auto-groups: this looks up an admin-curated
    :class:`~trueppm_api.apps.access.models.UserDefinedMentionGroup` by its
    case-insensitive name within the project and returns its current members,
    filtered to those who are still active project members.

    Snapshot semantics match the auto-group resolver: the returned list is the
    membership *at the moment of the mention*; later membership changes do not
    retroactively notify.

    Args:
        project_id: The project the mention was written in.
        name: The group name without the leading ``@`` (case-insensitive).

    Returns:
        A deduplicated list of member user UUIDs, or ``None`` if no live group
        with that name exists in the project (so the caller can fall through to
        treating the token as an unresolved user mention).
    """
    from django.db.models.functions import Lower

    from trueppm_api.apps.access.models import (
        ProjectMembership,
        UserDefinedMentionGroup,
    )

    key = name.strip().lstrip("@").lower()
    # Filter on Lower(name) rather than name__iexact so the case-insensitive
    # unique index (uniq_mention_group_project_name_ci, on Lower(name)) is usable.
    group = (
        UserDefinedMentionGroup.objects.annotate(name_lower=Lower("name"))
        .filter(
            project_id=project_id,
            name_lower=key,
            is_deleted=False,
        )
        .prefetch_related("members")
        .first()
    )
    if group is None:
        return None

    # Only notify members who still have an active project membership — a member
    # who left the project should not receive the ping even if the M2M row lingers.
    active_member_ids = set(
        ProjectMembership.objects.filter(
            project_id=project_id,
            is_deleted=False,
        ).values_list("user_id", flat=True)
    )
    member_ids = [member.pk for member in group.members.all() if member.pk in active_member_ids]
    return cast(list[uuid.UUID], list(dict.fromkeys(member_ids)))


def resolve_program_user_defined_group_members(
    program_id: uuid.UUID | str,
    name: str,
) -> list[uuid.UUID] | None:
    """Snapshot-resolve a program-scoped user-defined group name to member UUIDs.

    The program sibling of :func:`resolve_user_defined_group_members` (ADR-0248,
    #516). Looks up an owner-curated
    :class:`~trueppm_api.apps.access.models.ProgramUserDefinedMentionGroup` by its
    case-insensitive name within the program and returns its current members,
    filtered to those who still hold a live ``ProjectMembership`` on *some* project
    in the program (the ADR-0248 §2 union — a member who left every project in the
    program no longer receives the ping even if the M2M row lingers).

    Snapshot semantics match the auto-group and project-group resolvers.

    Args:
        program_id: The program that contains the project the mention was written
            in (``Project.program``).
        name: The group name without the leading ``@`` (case-insensitive).

    Returns:
        A deduplicated list of member user UUIDs, or ``None`` if no live group with
        that name exists in the program (so the caller can fall through to treating
        the token as an unresolved user mention).
    """
    from django.db.models.functions import Lower

    from trueppm_api.apps.access.models import (
        ProgramUserDefinedMentionGroup,
        ProjectMembership,
    )

    key = name.strip().lstrip("@").lower()
    group = (
        ProgramUserDefinedMentionGroup.objects.annotate(name_lower=Lower("name"))
        .filter(
            program_id=program_id,
            name_lower=key,
            is_deleted=False,
        )
        .prefetch_related("members")
        .first()
    )
    if group is None:
        return None

    active_member_ids = set(
        ProjectMembership.objects.filter(
            project__program_id=program_id,
            project__is_deleted=False,
            is_deleted=False,
        ).values_list("user_id", flat=True)
    )
    member_ids = [member.pk for member in group.members.all() if member.pk in active_member_ids]
    return cast(list[uuid.UUID], list(dict.fromkeys(member_ids)))
