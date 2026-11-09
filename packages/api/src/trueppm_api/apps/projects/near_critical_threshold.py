"""Workspace → Program → Project resolution for the near-critical float threshold (ADR-1381, #4907).

A task is *near-critical* when its total float is above zero but no more than this
many **working days**; float 0 is critical. The threshold only shades a display band
on the driving-chain payload — it never moves a date. It is set at the workspace by
default (10 working days, two weeks) and may be overridden per program or project.
The *effective* value is resolved here, computed-on-read (ADR-0108) — there is no
stored/denormalized effective column to keep in sync. Clients (web, mobile, MCP) read
the serializer's ``effective_near_critical_threshold_days`` or the driving-chain
payload's ``near_critical_threshold``; they never re-implement this precedence.

Precedence: project override → program override → workspace value.

Like the estimation scale (ADR-0510), the threshold has **no enforcement seam**: it is
a presentation preference, freely overridable at every scope, and OSS by construction.
A workspace-admin lock would import the Enterprise "policy-enforced inheritance"
surface and belongs in trueppm-enterprise. The Workspace root is non-null, so the
chain always resolves to a real value.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Program, Project
    from trueppm_api.apps.workspace.models import Workspace

#: The inheritable field, identically named on Workspace (non-null root), Program,
#: and Project (nullable override).
NEAR_CRITICAL_THRESHOLD_FIELD = "near_critical_threshold_days"

#: Which scope supplied the effective value. The Workspace root is non-null, so
#: resolution always terminates in a real scope.
NearCriticalThresholdSource = Literal["project", "program", "workspace"]


def _program_of(obj: Program | Project) -> Program | None:
    """The owning program of a project, or None for a program/standalone project."""
    from trueppm_api.apps.projects.models import Program

    if isinstance(obj, Program):
        return None
    return obj.program if obj.program_id else None


def _parent_value(obj: Program | Project, *, workspace: Workspace) -> int:
    """Resolve the threshold from ``obj``'s parent scope up to the workspace.

    A Program's parent is the workspace. A Project's parent is its program (whose own
    override resolves up to the workspace) or, if standalone, the workspace.
    """
    program = _program_of(obj)
    if program is not None:
        program_override = getattr(program, NEAR_CRITICAL_THRESHOLD_FIELD)
        if program_override is not None:
            return int(program_override)
    return int(getattr(workspace, NEAR_CRITICAL_THRESHOLD_FIELD))


def resolve_effective_near_critical_threshold(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> int:
    """Resolve the effective near-critical threshold, in working days.

    ``workspace`` may be passed to avoid re-loading the singleton per object when
    resolving a list (the serializer caches it once); otherwise it is loaded here.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    own = getattr(obj, NEAR_CRITICAL_THRESHOLD_FIELD)  # nullable override
    if own is not None:
        return int(own)
    return _parent_value(obj, workspace=workspace)


def resolve_inherited_near_critical_threshold(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> int:
    """Threshold ``obj`` would inherit if its own override were cleared.

    Drives a settings "Inherit (<value>)" affordance — it deliberately skips ``obj``'s
    own override and resolves from the parent scope up.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()
    return _parent_value(obj, workspace=workspace)


def resolve_near_critical_threshold_source(
    obj: Program | Project,
) -> NearCriticalThresholdSource:
    """Which scope supplied :func:`resolve_effective_near_critical_threshold` for ``obj``."""
    from trueppm_api.apps.projects.models import Program

    own = getattr(obj, NEAR_CRITICAL_THRESHOLD_FIELD)
    if own is not None:
        return "program" if isinstance(obj, Program) else "project"
    program = _program_of(obj)
    if program is not None and getattr(program, NEAR_CRITICAL_THRESHOLD_FIELD) is not None:
        return "program"
    return "workspace"


def float_band(total_float_working_days: int, threshold_working_days: int) -> str:
    """Classify a task's total float against the threshold.

    ``critical`` at float 0 (or negative: already late), ``near_critical`` for
    ``0 < float <= threshold``, otherwise ``ample``. The set is **open** — a client must
    tolerate a value it does not know, so a later tier is additive.
    """
    if total_float_working_days <= 0:
        return "critical"
    if total_float_working_days <= threshold_working_days:
        return "near_critical"
    return "ample"
