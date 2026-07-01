"""Independent leaf-surface visibility resolution (ADR-0193, issue 956).

A project ADMIN can independently hide four *leaf* surfaces — reporting,
time-tracking, baselines, and the Monte-Carlo surface — from their team's project
workspace, separately from the methodology preset (which already hides the heavy
chrome: Gantt/WBS/Sprints/Calendar, ADR-0041/ADR-0107).

**Hide-only (ADR-0041):** turning a surface off never disables its endpoint or
gates its route — the data is always computed and reachable by direct URL. These
toggles hide chrome; they are a preference, not a permission.

**Seeded by methodology, not by parent scope.** Unlike sharing/attachment
inheritance (project → program → workspace, see ``sharing_settings``), the *default*
for each surface comes from the project's ``effective_methodology`` via
``METHODOLOGY_SURFACE_DEFAULTS``. Resolution is therefore two-level and
computed-on-read (ADR-0108 — no denormalized column):

    effective(surface) = project.show_<surface>              # explicit override
                         if project.show_<surface> is not None
                         else METHODOLOGY_SURFACE_DEFAULTS[effective_methodology][surface]

Clients (web, mobile, MCP) read the serializer's ``effective_surface_visibility``;
they never re-implement this map. There is no ENFORCE/lock seam — this is a
per-project preference, not a cross-scope policy, so nothing degrades to SUGGEST
and no enterprise provider registers against it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from trueppm_api.apps.projects.models import Methodology

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project
    from trueppm_api.apps.workspace.models import Workspace

#: The four independently-toggleable leaf surfaces. The key is the API/serializer
#: name; the backing column is ``show_<key>`` on ``Project``.
SURFACE_KEYS: tuple[str, ...] = ("reporting", "time_tracking", "baselines", "monte_carlo")

#: Default visibility when a project leaves ``show_<surface>`` NULL (inherit). These
#: are *floors seeded from the methodology preset*, fully overridable per project
#: (OSS never clamps — ADR-0135 §5). Baselines and Monte-Carlo default off under
#: AGILE (CPM/schedule artifacts an agile team rarely surfaces — the issue's own
#: example); reporting and time-tracking default on everywhere (universally useful).
METHODOLOGY_SURFACE_DEFAULTS: dict[str, dict[str, bool]] = {
    Methodology.WATERFALL: {
        "reporting": True,
        "time_tracking": True,
        "baselines": True,
        "monte_carlo": True,
    },
    Methodology.AGILE: {
        "reporting": True,
        "time_tracking": True,
        "baselines": False,
        "monte_carlo": False,
    },
    Methodology.HYBRID: {
        "reporting": True,
        "time_tracking": True,
        "baselines": True,
        "monte_carlo": True,
    },
}


def methodology_surface_defaults(effective_methodology: str) -> dict[str, bool]:
    """Default visibility map for a resolved methodology.

    Falls back to the HYBRID (all-on, lossless) defaults for any unknown value, so
    a future methodology never accidentally hides a surface.
    """
    return dict(
        METHODOLOGY_SURFACE_DEFAULTS.get(
            effective_methodology, METHODOLOGY_SURFACE_DEFAULTS[Methodology.HYBRID]
        )
    )


def resolve_effective_visibility(
    project: Project, *, workspace: Workspace | None = None
) -> dict[str, bool]:
    """Resolve the effective visibility of every leaf surface for ``project``.

    Each surface uses the project's explicit override when set, otherwise the
    methodology default. ``workspace`` may be passed to avoid re-loading the
    singleton when resolving a list (the serializer caches it once).
    """
    from trueppm_api.apps.projects.methodology import resolve_effective_methodology

    effective_methodology = resolve_effective_methodology(project, workspace=workspace)
    defaults = methodology_surface_defaults(effective_methodology)

    resolved: dict[str, bool] = {}
    for surface in SURFACE_KEYS:
        override = getattr(project, f"show_{surface}")
        resolved[surface] = bool(override) if override is not None else defaults[surface]
    return resolved


def resolve_inherited_visibility(
    project: Project, *, workspace: Workspace | None = None
) -> dict[str, bool]:
    """Visibility ``project`` would show if every override were cleared.

    This is exactly the methodology-default map for the project's effective
    methodology — it drives the settings "Inherit (On/Off)" affordance, letting the
    UI show what each toggle falls back to when returned to *inherit*.
    """
    from trueppm_api.apps.projects.methodology import resolve_effective_methodology

    effective_methodology = resolve_effective_methodology(project, workspace=workspace)
    return methodology_surface_defaults(effective_methodology)
