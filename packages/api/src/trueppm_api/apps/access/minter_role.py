"""The one membership read that must see revoked rows on a token write path (#4334).

Kept in its own module on purpose: ``scripts/check-membership-live-floor.py`` fails any
``ProjectMembership`` read that omits ``is_deleted``, and allowlists by module. Putting
this read in ``permissions.py`` would mean allowlisting the whole permission module and
blinding the gate to every other read there. Nothing else belongs in this file.
"""

from __future__ import annotations

from typing import Any

from trueppm_api.apps.access.models import ProjectMembership


def last_recorded_project_role(project_id: Any, user_id: Any) -> int | None:
    """Return ``user_id``'s most recent role on ``project_id``, live or revoked.

    Deliberately NOT floored on ``is_deleted``. ``IsTokenForProject`` applies its
    Member+ floor to a project-scoped token's minter using this role: removal is a soft
    delete that keeps ``role`` intact, so a minter removed in good standing still clears
    the floor (the token survives off-boarding), while a minter demoted below Member and
    then removed — including by self-removal — does not. Reading only the live row made
    removal an unconditional pass, which let a demoted minter undo their own demotion.

    ``(project, user)`` is unique unconditionally (a re-add revives the same row), so
    there is at most one row; ordering by ``server_version`` only keeps "most recent"
    true if that ever changes.

    Returns:
        The role ordinal, or ``None`` when no row exists at all.
    """
    return (
        ProjectMembership.objects.filter(project_id=project_id, user_id=user_id)
        .order_by("-server_version")
        .values_list("role", flat=True)
        .first()
    )
