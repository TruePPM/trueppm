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

Both are *band members* on the web since ADR-0942 (they used to stand outside every
band, which is the only reason they were unhideable). Their absence here is therefore
no longer a structural consequence of anything — it is an authored decision on both
sides, and the thing that keeps the two sides honest is
``contracts/hideable-views.json``: this set and the web's ``HIDEABLE_VIEW_KEYS`` each
assert against it, in pytest and in vitest respectively. Adding a hideable view means
editing all three; any one alone fails a pipeline. Prose asking to "keep the two lists
in sync" is what let the web derive this set from band membership in the first place.

A key absent here is rejected with a 400 by
``UserProfileSerializer.validate_hidden_views``.
"""

from __future__ import annotations

# Grouped for readability only — the *rendered* band of a key is methodology-adaptive on
# the web (ADR-0195: Board joins the DELIVER circuit on AGILE/HYBRID, stays in TRACK on
# WATERFALL). Hideability is per-key and independent of band, so this set is unchanged by
# that layout — and by ADR-0942's retaxonomy, which moved four keys between bands and
# added none: every key below is hideable on every methodology.
HIDEABLE_VIEW_KEYS: frozenset[str] = frozenset(
    {
        # PLAN band
        "schedule",
        "grid",
        "calendar",
        # DELIVER band (AGILE/HYBRID) — Backlog · Sprints · Board (ADR-0195)
        "product-backlog",
        "sprints",
        "board",
        # TRACK band
        "today",
        "risk",
        "reports",
        "activity",
        # Unified Assets surface (#971, ADR-0215) — trails TRACK on the web.
        "assets",
        # WORKSPACE scope band (ADR-0942) — Team, beside the unhideable Settings.
        "resources",
    }
)
