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

from dataclasses import dataclass, field

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


# ---------------------------------------------------------------------------
# Resolved project view set (ADR-1478)
# ---------------------------------------------------------------------------

#: Views that are band members but can never be hidden (``source: always``).
ALWAYS_ON_VIEW_KEYS: frozenset[str] = frozenset({"overview", "settings"})

#: Every key the resolver returns, in the order ``GET /projects/{id}/views/`` lists them.
#: Order is a stable reading order for clients, not tab order (the lens owns that,
#: ADR-0162, and stays presentation-only on the web).
RESOLVED_VIEW_ORDER: tuple[str, ...] = (
    "overview",
    "schedule",
    "grid",
    "calendar",
    "product-backlog",
    "sprints",
    "board",
    "today",
    "risk",
    "reports",
    "activity",
    "assets",
    "resources",
    "settings",
)

#: The layouts the Plan tab offers. At least one must stay visible (ADR-1478 §3 "never
#: empty"); the resolver falls back to ``schedule`` and a write that would hide the last
#: one is refused with ``400 last_plan_layout``.
PLAN_LAYOUT_KEYS: tuple[str, ...] = ("schedule", "grid", "calendar")

#: Methodology defaults (ADR-0041), moved here from the web bundle by ADR-1478 §2 and
#: asserted against ``contracts/methodology-views.json`` in pytest and vitest. These are
#: **advisory**: a methodology-hidden view stays reachable from More and by URL.
METHODOLOGY_HIDDEN_VIEWS: dict[str, frozenset[str]] = {
    "WATERFALL": frozenset({"sprints", "product-backlog"}),
    "AGILE": frozenset({"schedule", "calendar"}),
    "HYBRID": frozenset(),
}

#: Views methodology may never remove from the resolved set. Shell v2 rule: Plan always offers
#: Schedule, so AGILE's methodology default hides only ``calendar`` once resolved. A seed
#: or user hide of ``schedule`` is still honored.
METHODOLOGY_NEVER_HIDES: frozenset[str] = frozenset({"schedule"})


@dataclass(frozen=True)
class LensSeed:
    """What a role lens suggests at a user's first open of a project (ADR-1478 §2).

    ``hide`` narrows the methodology default; it never widens it. ``landing`` maps a
    methodology to the view the lens opens on. Both may only name keys in
    ``HIDEABLE_VIEW_KEYS``; a retired key is ignored and logged by the resolver so a
    view-inventory change (#3887) cannot break seeding.
    """

    hide: frozenset[str]
    landing: dict[str, str] = field(default_factory=dict)


#: Seeds keyed by ``RoleContext`` value. Shipped defaults only: an admin-editable
#: registry would need an ``enterprise-check`` first (Q1.3). The Product Owner seed
#: arrives with the PO lens (#1467); ``unified`` seeds nothing, which is today's default.
LENS_VIEW_SEEDS: dict[str, LensSeed] = {
    "pm": LensSeed(
        hide=frozenset({"product-backlog"}),
        landing={"WATERFALL": "schedule", "AGILE": "schedule", "HYBRID": "schedule"},
    ),
    "scrum_master": LensSeed(
        hide=frozenset({"schedule", "calendar", "resources"}),
        landing={"WATERFALL": "board", "AGILE": "board", "HYBRID": "board"},
    ),
    "unified": LensSeed(hide=frozenset()),
}
