"""Workspace → Program → Project resolution for the sprint story picker's

default "Ready only" filter (ADR-0758, #2670).

The Sprints page's story picker offers backlog stories to commit into a
PLANNED sprint. By default it shows only stories at ``Task.dor == READY``
(ADR-0105) — a story missing an estimate or an unmet acceptance criterion is
filtered out of the default view rather than offered for one-click commit.
This is a per-scope *default* for that filter, not a permission: the picker
always carries a "Show all" escape hatch that reveals blocked stories with
their reason codes, and committing a non-ready story is never hard-blocked in
OSS (see ``product_backlog_services.dor_blockers`` — the READY gate itself is
advisory, and this setting governs the picker's starting view, not what a user
is allowed to do).

The *effective* default is resolved here, computed-on-read (ADR-0108) — there
is no stored/denormalized effective column to keep in sync. Clients (web,
mobile, MCP) read the serializer's ``effective_sprint_picker_ready_only_default``;
they never re-implement this precedence.

Precedence: project override → program override → workspace value.

Mirrors ``estimation_scale``: there is **no override_policy** and no
enforcement seam. Unlike sharing/duration-policy, a "ready only by default"
setting has no meaningful non-degenerate ENFORCE behavior without also
building the hard commit-time block the governing issue (#2670) explicitly
scopes out of OSS — so this field is a plain PO/team preference, freely
overridable at every scope (OSS by construction). A future Enterprise ADR that
adds a genuine hard-block gate would introduce its own override_policy/
enforcement seam rather than retrofitting one here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Program, Project
    from trueppm_api.apps.workspace.models import Workspace

#: The inheritable field, identically named on Workspace (non-null root),
#: Program, and Project (nullable override).
SPRINT_PICKER_READY_ONLY_FIELD = "sprint_picker_ready_only_default"

#: Which scope supplied the effective default. No ``system_default`` — the
#: Workspace root is non-null, so resolution always terminates in a real scope.
SprintPickerReadyOnlySource = Literal["project", "program", "workspace"]


def _program_of(obj: Program | Project) -> Program | None:
    """The owning program of a project, or None for a program/standalone project."""
    from trueppm_api.apps.projects.models import Program

    if isinstance(obj, Program):
        return None
    return obj.program if obj.program_id else None


def _parent_value(obj: Program | Project, *, workspace: Workspace) -> bool:
    """Resolve the default from ``obj``'s parent scope up to the workspace.

    A Program's parent is the workspace. A Project's parent is its program (whose
    own override resolves up to the workspace) or, if standalone, the workspace.
    """
    program = _program_of(obj)
    if program is not None:
        program_override = getattr(program, SPRINT_PICKER_READY_ONLY_FIELD)
        if program_override is not None:
            return bool(program_override)
    return bool(getattr(workspace, SPRINT_PICKER_READY_ONLY_FIELD))


def resolve_effective_sprint_picker_ready_only(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> bool:
    """Resolve the effective "Ready only" default for a program or project.

    ``workspace`` may be passed to avoid re-loading the singleton per object when
    resolving a list (the serializer caches it once); otherwise it is loaded here.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    own = getattr(obj, SPRINT_PICKER_READY_ONLY_FIELD)  # nullable override
    if own is not None:
        return bool(own)
    return _parent_value(obj, workspace=workspace)


def resolve_inherited_sprint_picker_ready_only(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> bool:
    """Default ``obj`` would inherit if its own override were cleared.

    Drives a settings "Inherit (On/Off)" affordance — it deliberately skips
    ``obj``'s own override and resolves from the parent scope up.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()
    return _parent_value(obj, workspace=workspace)


def resolve_sprint_picker_ready_only_source(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> SprintPickerReadyOnlySource:
    """Which scope supplied :func:`resolve_effective_sprint_picker_ready_only`.

    The breadcrumb the settings UI reads to explain which scope set the
    default, without re-deriving the precedence. ``workspace`` is accepted for
    signature symmetry with the other resolvers (it is never needed — the
    terminal scope is "workspace" by elimination).
    """
    from trueppm_api.apps.projects.models import Program

    if not isinstance(obj, Program) and getattr(obj, SPRINT_PICKER_READY_ONLY_FIELD) is not None:
        return "project"
    if isinstance(obj, Program) and getattr(obj, SPRINT_PICKER_READY_ONLY_FIELD) is not None:
        return "program"
    program = _program_of(obj)
    if program is not None and getattr(program, SPRINT_PICKER_READY_ONLY_FIELD) is not None:
        return "program"
    return "workspace"
