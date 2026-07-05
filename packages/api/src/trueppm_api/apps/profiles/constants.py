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

# Grouped for readability only — the *rendered* group of a key is methodology-adaptive
# on the web (ADR-0195: Board joins the SPRINT circuit on AGILE/HYBRID, stays in TRACK on
# WATERFALL). Hideability is per-key and independent of group, so this set is unchanged by
# that layout: every key below is hideable on every methodology.
HIDEABLE_VIEW_KEYS: frozenset[str] = frozenset(
    {
        # PLAN group
        "schedule",
        "grid",
        "calendar",
        # SPRINT group (AGILE/HYBRID) — Backlog · Sprints · Board (ADR-0195)
        "product-backlog",
        "sprints",
        "board",
        # TRACK group
        "today",
        "risk",
        "reports",
        "activity",
        # Unified Assets surface (#971, ADR-0212) — trails TRACK on the web.
        "assets",
        # PEOPLE group
        "resources",
    }
)
