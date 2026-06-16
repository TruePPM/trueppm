"""Workspace → Program → Project sharing-settings resolution (ADR-0135, #978).

``public_sharing`` (anyone with the link can view, no sign-in) and ``allow_guests``
(external collaborators) are set at the workspace by default and may be overridden
per program/project. The *effective* value is resolved here, computed-on-read
(ADR-0108) — there is no stored/denormalized effective column to keep in sync.
Clients (web, mobile, MCP) read the serializer's ``effective_public_sharing`` /
``effective_allow_guests``; they never re-implement this precedence.

Precedence: project override → program override → workspace value.
``inherited_*`` answers "what would I get if this scope's override were cleared?"
(i.e. the parent's effective value) and drives the settings "Inherit (On/Off)"
affordance.

``ENFORCE`` (a workspace admin locking sharing so lower scopes cannot *loosen* it)
is an Enterprise capability. OSS ships the neutral hook below and registers no
provider, so ``ENFORCE`` degrades to ``SUGGEST`` (no lock) — a program/project may
freely loosen or tighten. trueppm-enterprise registers a provider in its
``AppConfig.ready()`` — the integrations-registry idiom (ADR-0029/0049), mirroring
``iteration_label.register_terminology_enforcement_provider``. OSS never imports
enterprise.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Program, Project
    from trueppm_api.apps.workspace.models import Workspace

#: The two inheritable sharing booleans. The field name is identical on
#: Workspace (non-null root), Program, and Project (nullable override), so the
#: resolver below is field-agnostic.
SHARING_FIELDS = ("public_sharing", "allow_guests")

# Enterprise registers a zero-arg predicate that returns True when sharing
# enforcement is licensed/active. OSS leaves it None → enforcement inactive, so
# ENFORCE behaves as SUGGEST (no lock).
_ENFORCEMENT_PROVIDER: Callable[[], bool] | None = None


def register_sharing_enforcement_provider(provider: Callable[[], bool] | None) -> None:
    """Register (or clear) the sharing-enforcement provider. Enterprise calls this."""
    global _ENFORCEMENT_PROVIDER
    _ENFORCEMENT_PROVIDER = provider


def sharing_enforcement_active() -> bool:
    """True only when an enterprise provider is registered AND reports active.

    OSS has no provider → always False, so a workspace ``ENFORCE`` policy never
    locks downstream sharing overrides in the community edition.
    """
    return _ENFORCEMENT_PROVIDER is not None and bool(_ENFORCEMENT_PROVIDER())


def _enforced(workspace: Workspace) -> bool:
    """Whether the workspace value is a hard ceiling (Enterprise lock active)."""
    from trueppm_api.apps.workspace.models import TermOverridePolicy

    return (
        workspace.public_sharing_override_policy == TermOverridePolicy.ENFORCE
        and sharing_enforcement_active()
    )


def resolve_effective_sharing(
    obj: Program | Project,
    field: str,
    *,
    workspace: Workspace | None = None,
) -> bool:
    """Resolve the effective value of ``field`` for a program or project.

    ``workspace`` may be passed to avoid re-loading the singleton per object when
    resolving a list (the serializer caches it once); otherwise it is loaded here.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    ws_value = bool(getattr(workspace, field))
    if _enforced(workspace):
        # Enterprise lock: the workspace value wins regardless of lower overrides.
        return ws_value

    own = getattr(obj, field)  # nullable override on Program/Project
    if own is not None:
        return bool(own)
    return _parent_value(obj, field, workspace=workspace)


def resolve_inherited_sharing(
    obj: Program | Project,
    field: str,
    *,
    workspace: Workspace | None = None,
) -> bool:
    """Value ``obj`` would inherit if its own override were cleared.

    Drives the settings "Inherit (On/Off)" affordance — it deliberately skips
    ``obj``'s own override and resolves from the parent up. Under an active
    Enterprise lock the inherited value is the (ceiling) workspace value.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    if _enforced(workspace):
        return bool(getattr(workspace, field))
    return _parent_value(obj, field, workspace=workspace)


def _parent_value(
    obj: Program | Project,
    field: str,
    *,
    workspace: Workspace,
) -> bool:
    """Resolve ``field`` from ``obj``'s parent scope up to the workspace.

    A Program's parent is the workspace. A Project's parent is its program (whose
    own override resolves up to the workspace) or, if standalone, the workspace.
    """
    # Local import keeps this module import-safe from migrations.
    from trueppm_api.apps.projects.models import Program

    # A Program's parent is the workspace (no intermediate scope); a Project's
    # parent is its program, if it has one.
    program: Program | None = None
    if not isinstance(obj, Program) and obj.program_id:
        program = obj.program

    if program is not None:
        program_override = getattr(program, field)
        if program_override is not None:
            return bool(program_override)

    return bool(getattr(workspace, field))
