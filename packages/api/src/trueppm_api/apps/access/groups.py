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

User-defined groups (#515, ADR-0212) are curated per project and resolved by
the separate ``resolve_user_defined_group_members`` path below — distinct from
the RBAC-derived auto-groups above.
"""

from __future__ import annotations

import uuid
from typing import cast

# ADR-0075 locked constraint #1 — @all resolve cardinality cap.
ALL_GROUP_HARD_CAP: int = 200

# Auto-group keys recognized in 0.2.
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
        InvalidGroupKeyError: group_key is not in KNOWN_GROUP_KEYS
        GroupTooLargeError:   @all expands to more than ALL_GROUP_HARD_CAP users
    """
    # Local imports to avoid app-loading ordering surprises during AppConfig
    # ready() — resolver is only ever called from request paths.
    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.projects.models import Sprint, SprintState, Task

    key = group_key.strip().lower()
    if key not in KNOWN_GROUP_KEYS:
        raise InvalidGroupKeyError(group_key)

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

    # Unreachable — KNOWN_GROUP_KEYS membership was checked above.
    raise InvalidGroupKeyError(group_key)  # pragma: no cover


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
