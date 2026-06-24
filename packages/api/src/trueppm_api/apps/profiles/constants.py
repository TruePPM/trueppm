"""Canonical view-key vocabulary for per-user nav customization (ADR-0139).

The web nav (``packages/web/src/features/shell/methodologyTabs.ts``) owns the
*display* registry (grouping, labels, icons). This module is the server-side
source of truth for *which* view keys a user is allowed to hide, so the API can
validate ``UserProfile.hidden_views`` and MCP/API clients can enumerate the
vocabulary without scraping the web bundle.

``overview`` is intentionally absent — it is the always-on landing surface
(ADR-0030) and may never be hidden; keeping it unhideable is the structural
guarantee that a user's nav can never be emptied. ``settings`` is also absent —
it is an admin surface, not a hideable workflow view.

When a new hideable view is added to the web ``VIEW_GROUPS``, add its key here
too (the two lists are deliberately coupled; a key absent here is rejected with
a 400 by ``UserProfileSerializer.validate_hidden_views``).
"""

from __future__ import annotations

HIDEABLE_VIEW_KEYS: frozenset[str] = frozenset(
    {
        # PLAN group
        "product-backlog",
        "sprints",
        "schedule",
        "grid",
        "calendar",
        # TRACK group
        "today",
        "board",
        "risk",
        "reports",
        # PEOPLE group
        "resources",
    }
)
