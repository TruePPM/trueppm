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

User-defined groups (#515 / #516) are NOT resolved here — those land later
with their own management UI and a separate resolver path.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

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
    if key in role_floors:
        user_ids: Iterable[uuid.UUID] = (
            ProjectMembership.objects.filter(
                project_id=project_id,
                role__gte=role_floors[key],
                is_deleted=False,
            )
            .values_list("user_id", flat=True)
            .distinct()
        )
        return list(dict.fromkeys(user_ids))  # dedupe-preserving order

    if key == "all":
        user_ids = (
            ProjectMembership.objects.filter(project_id=project_id, is_deleted=False)
            .values_list("user_id", flat=True)
            .distinct()
        )
        result = list(dict.fromkeys(user_ids))
        if len(result) > ALL_GROUP_HARD_CAP:
            raise GroupTooLargeError(key, len(result))
        return result

    if key == "scrum-team":
        active_sprint_ids = Sprint.objects.filter(
            project_id=project_id,
            state=SprintState.ACTIVE,
            is_deleted=False,
        ).values_list("id", flat=True)
        user_ids = (
            Task.objects.filter(
                project_id=project_id,
                is_deleted=False,
                assignee__isnull=False,
                sprint_id__in=list(active_sprint_ids),
            )
            .values_list("assignee_id", flat=True)
            .distinct()
        )
        return list(dict.fromkeys(user_ids))

    # Unreachable — KNOWN_GROUP_KEYS membership was checked above.
    raise InvalidGroupKeyError(group_key)  # pragma: no cover
