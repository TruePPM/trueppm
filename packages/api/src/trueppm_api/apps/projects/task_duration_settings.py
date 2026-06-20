"""Workspace → Program → Project resolution for the duration-change percent policy (ADR-0151, #414).

When a task's ``duration`` changes, ``task_duration_change_percent_policy``
decides what happens to its ``percent_complete`` (keep / prorate / confirm). The
policy is set at the workspace by default and may be overridden per program or
project. The *effective* policy is resolved here, computed-on-read (ADR-0108) —
there is no stored/denormalized effective column to keep in sync. Clients (web,
mobile, MCP) read the serializer's ``effective_task_duration_change_percent_policy``;
they never re-implement this precedence, and ``TaskSerializer.update`` calls
:func:`resolve_effective_duration_policy` to decide how to treat ``%``.

Precedence: project override → program override → workspace value.

``ENFORCE`` (a workspace admin locking the policy so lower scopes cannot override
it) is an Enterprise capability. OSS ships the neutral hook below and registers no
provider, so ``ENFORCE`` degrades to ``SUGGEST`` (no lock) — a program/project may
freely override. trueppm-enterprise registers a provider in its
``AppConfig.ready()`` — the integrations-registry idiom (ADR-0029/0049), mirroring
``sharing_settings.register_sharing_enforcement_provider``. OSS never imports
enterprise.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Program, Project
    from trueppm_api.apps.workspace.models import Workspace

#: The inheritable policy field, identically named on Workspace (non-null root),
#: Program, and Project (nullable override).
DURATION_POLICY_FIELD = "task_duration_change_percent_policy"

# Enterprise registers a zero-arg predicate that returns True when policy
# enforcement is licensed/active. OSS leaves it None → enforcement inactive, so
# ENFORCE behaves as SUGGEST (no lock).
_ENFORCEMENT_PROVIDER: Callable[[], bool] | None = None


def register_duration_policy_enforcement_provider(provider: Callable[[], bool] | None) -> None:
    """Register (or clear) the policy-enforcement provider. Enterprise calls this."""
    global _ENFORCEMENT_PROVIDER
    _ENFORCEMENT_PROVIDER = provider


def duration_policy_enforcement_active() -> bool:
    """True only when an enterprise provider is registered AND reports active.

    OSS has no provider → always False, so a workspace ``ENFORCE`` policy never
    locks downstream overrides in the community edition.
    """
    return _ENFORCEMENT_PROVIDER is not None and bool(_ENFORCEMENT_PROVIDER())


def _enforced(workspace: Workspace) -> bool:
    """Whether the workspace value is a hard lock (Enterprise enforcement active)."""
    from trueppm_api.apps.workspace.models import TermOverridePolicy

    return (
        workspace.task_duration_change_percent_override_policy == TermOverridePolicy.ENFORCE
        and duration_policy_enforcement_active()
    )


def resolve_effective_duration_policy(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> str:
    """Resolve the effective duration-change percent policy for a program or project.

    ``workspace`` may be passed to avoid re-loading the singleton per object when
    resolving a list (the serializer caches it once); otherwise it is loaded here.
    Returns a :class:`~trueppm_api.apps.projects.models.DurationChangePercentPolicy`
    value (``keep`` | ``prorate`` | ``confirm``).
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    ws_value = str(getattr(workspace, DURATION_POLICY_FIELD))
    if _enforced(workspace):
        # Enterprise lock: the workspace value wins regardless of lower overrides.
        return ws_value

    own = getattr(obj, DURATION_POLICY_FIELD)  # nullable override on Program/Project
    if own:
        return str(own)
    return _parent_value(obj, workspace=workspace)


def resolve_inherited_duration_policy(
    obj: Program | Project,
    *,
    workspace: Workspace | None = None,
) -> str:
    """Policy ``obj`` would inherit if its own override were cleared.

    Drives a settings "Inherit (<value>)" affordance — it deliberately skips
    ``obj``'s own override and resolves from the parent up. Under an active
    Enterprise lock the inherited value is the (ceiling) workspace value.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    if _enforced(workspace):
        return str(getattr(workspace, DURATION_POLICY_FIELD))
    return _parent_value(obj, workspace=workspace)


def _parent_value(
    obj: Program | Project,
    *,
    workspace: Workspace,
) -> str:
    """Resolve the policy from ``obj``'s parent scope up to the workspace.

    A Program's parent is the workspace. A Project's parent is its program (whose
    own override resolves up to the workspace) or, if standalone, the workspace.
    """
    # Local import keeps this module import-safe from migrations.
    from trueppm_api.apps.projects.models import Program

    program: Program | None = None
    if not isinstance(obj, Program) and obj.program_id:
        program = obj.program

    if program is not None:
        program_override = getattr(program, DURATION_POLICY_FIELD)
        if program_override:
            return str(program_override)

    return str(getattr(workspace, DURATION_POLICY_FIELD))
