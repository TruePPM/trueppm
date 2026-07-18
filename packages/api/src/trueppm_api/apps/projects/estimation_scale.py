"""Workspace → Program → Project resolution for the estimation scale (ADR-0510, #2027).

Story-point estimates are stored as a single integer (``Task.story_points`` /
``BacklogItem.story_points``). The ``estimation_scale`` enum decides only which
input widget and display label the client renders for that integer — Fibonacci,
Linear, or T-shirt — never the stored value or any velocity/rollup math. The scale
is set at the workspace by default and may be overridden per program or project.
The *effective* scale is resolved here, computed-on-read (ADR-0108) — there is no
stored/denormalized effective column to keep in sync. Clients (web, mobile, MCP)
read the serializer's ``effective_estimation_scale``; they never re-implement this
precedence.

Precedence: project override → program override → workspace value.

Unlike the calendar (ADR-0441) and duration policy (ADR-0151), the estimation scale
has **no enforcement seam** — it is a plain PO/team preference, freely overridable
at every scope, and OSS by construction (ADR-0510, enterprise-check). Adding a lock
flag, override-suppression, or an inheritance-change audit would import the
Enterprise "policy-enforced inheritance" surface and belongs in trueppm-enterprise.
The Workspace root is non-null (default Fibonacci), so the chain always resolves to
a real value; there is no ``system_default`` terminal (contrast the calendar's
Mon-Fri/8h/UTC backstop).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Program, Project
    from trueppm_api.apps.workspace.models import Workspace

#: The inheritable field, identically named on Workspace (non-null root), Program,
#: and Project (nullable override).
ESTIMATION_SCALE_FIELD = "estimation_scale"

#: Which scope supplied the effective scale. No ``system_default`` — the Workspace
#: root is non-null, so resolution always terminates in a real scope.
EstimationScaleSource = Literal["project", "program", "workspace"]


def _program_of(obj: Program | Project) -> Program | None:
    """The owning program of a project, or None for a program/standalone project."""
    from trueppm_api.apps.projects.models import Program

    if isinstance(obj, Program):
        return None
    return obj.program if obj.program_id else None


def _parent_value(obj: Program | Project, *, workspace: Workspace) -> str:
    """Resolve the scale from ``obj``'s parent scope up to the workspace.

    A Program's parent is the workspace. A Project's parent is its program (whose
    own override resolves up to the workspace) or, if standalone, the workspace.
    """
    program = _program_of(obj)
    if program is not None:
        program_override = getattr(program, ESTIMATION_SCALE_FIELD)
        if program_override:
            return str(program_override)
    return str(getattr(workspace, ESTIMATION_SCALE_FIELD))


def resolve_effective_estimation_scale(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> str:
    """Resolve the effective estimation scale for a program or project.

    ``workspace`` may be passed to avoid re-loading the singleton per object when
    resolving a list (the serializer caches it once); otherwise it is loaded here.
    Returns an :class:`~trueppm_api.apps.projects.models.EstimationScale` value
    (``fibonacci`` | ``linear`` | ``tshirt``).
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    own = getattr(obj, ESTIMATION_SCALE_FIELD)  # nullable override on Program/Project
    if own:
        return str(own)
    return _parent_value(obj, workspace=workspace)


def resolve_inherited_estimation_scale(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> str:
    """Scale ``obj`` would inherit if its own override were cleared.

    Drives a settings "Inherit (<value>)" affordance — it deliberately skips
    ``obj``'s own override and resolves from the parent scope up.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()
    return _parent_value(obj, workspace=workspace)


def resolve_estimation_scale_source(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> EstimationScaleSource:
    """Which scope supplied :func:`resolve_effective_estimation_scale` for ``obj``.

    The breadcrumb the settings UI reads to explain which scope set the scale,
    without re-deriving the precedence. ``workspace`` is accepted for signature
    symmetry with the other resolvers (it is never needed — the terminal scope is
    "workspace" by elimination).
    """
    from trueppm_api.apps.projects.models import Program

    if not isinstance(obj, Program) and getattr(obj, ESTIMATION_SCALE_FIELD):
        return "project"
    if isinstance(obj, Program) and getattr(obj, ESTIMATION_SCALE_FIELD):
        return "program"
    program = _program_of(obj)
    if program is not None and getattr(program, ESTIMATION_SCALE_FIELD):
        return "program"
    return "workspace"
