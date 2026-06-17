"""Workspace → Program → Project Monte Carlo forecast-history resolution (ADR-0144, #1232).

The three forecast-history settings — ``mc_history_enabled`` (whether the run
history list is exposed at all), ``mc_history_retention_cap`` (how many runs the
nightly purge keeps), and ``mc_history_attribution_audience`` (who may see the
run-author name) — default at the workspace and may be overridden per
program/project. The *effective* value is resolved here, computed-on-read
(ADR-0108): there is no stored/denormalized effective column to keep in sync.
Clients (web, mobile, MCP) read the serializer's ``effective_mc_history_*`` /
``inherited_mc_history_*``; they never re-implement this precedence.

Precedence: project override → program override → workspace value → Django
settings default. ``inherited_*`` answers "what would I get if this scope's
override were cleared?" (i.e. the parent's effective value) and drives the
settings "Inherit (…)" affordance.

This module is the forecast-history sibling of ``apps.projects.sharing_settings``
(ADR-0135) and ``apps.projects.iteration_label`` (ADR-0116); it deliberately
mirrors their resolver + enforcement-provider shape. ``ENFORCE`` (a workspace
admin locking the config so lower scopes cannot override it) is an Enterprise
capability. OSS ships the inert provider below and registers nothing, so
``ENFORCE`` degrades to ``SUGGEST`` (no lock). trueppm-enterprise registers a
provider in its ``AppConfig.ready()`` — the integrations-registry idiom
(ADR-0029/0049). OSS never imports enterprise.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from django.conf import settings

from trueppm_api.apps.scheduling.models import MCAttributionAudience

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Program, Project
    from trueppm_api.apps.workspace.models import Workspace

#: The three inheritable forecast-history settings. The field name is identical on
#: Workspace (non-null root), Program, and Project (nullable override), so the
#: resolver below is field/key-agnostic.
MC_HISTORY_FIELDS = (
    "mc_history_enabled",
    "mc_history_retention_cap",
    "mc_history_attribution_audience",
)

# Enterprise registers a zero-arg predicate that returns True when forecast-history
# enforcement is licensed/active. OSS leaves it None → enforcement inactive, so
# ENFORCE behaves as SUGGEST (no lock).
_ENFORCEMENT_PROVIDER: Callable[[], bool] | None = None


def register_forecast_history_enforcement_provider(provider: Callable[[], bool] | None) -> None:
    """Register (or clear) the forecast-history enforcement provider. Enterprise calls this."""
    global _ENFORCEMENT_PROVIDER
    _ENFORCEMENT_PROVIDER = provider


def forecast_history_enforcement_active(workspace: Workspace | None = None) -> bool:
    """True only when an enterprise provider is registered AND reports active.

    OSS has no provider → always False, so a workspace ``ENFORCE`` policy never
    locks downstream forecast-history overrides in the community edition.
    ``workspace`` is accepted for signature parity with the sharing seam and any
    future provider that needs the workspace context; the inert OSS path ignores it.
    """
    return _ENFORCEMENT_PROVIDER is not None and bool(_ENFORCEMENT_PROVIDER())


def _settings_default(key: str) -> Any:
    """The installation-wide fallback for ``key`` when nothing up the chain is set.

    ``MC_HISTORY_CAP`` may be ``None`` (Enterprise unlimited retention); when it is
    we fall back to the non-null Workspace default of 100 so the resolver always
    returns a concrete int for the retention cap.
    """
    if key == "mc_history_enabled":
        return True
    if key == "mc_history_attribution_audience":
        return MCAttributionAudience.ADMIN_OWNER
    if key == "mc_history_retention_cap":
        cap = settings.MC_HISTORY_CAP
        return cap if cap is not None else 100
    raise ValueError(f"Unknown forecast-history key: {key}")


def _clamp(key: str, value: Any) -> Any:
    """Clamp a resolved value to its hard bound.

    ``mc_history_retention_cap`` is clamped to ``settings.MC_HISTORY_HARD_CAP`` so a
    misconfigured (or future Enterprise-injected) value can never unbound the
    nightly purge, which would otherwise let per-project history grow without limit.
    """
    if key == "mc_history_retention_cap" and value is not None:
        return min(int(value), settings.MC_HISTORY_HARD_CAP)
    return value


def _enforced(workspace: Workspace) -> bool:
    """Whether the workspace value is a hard lock (Enterprise enforcement active)."""
    from trueppm_api.apps.workspace.models import TermOverridePolicy

    return (
        workspace.mc_history_override_policy == TermOverridePolicy.ENFORCE
        and forecast_history_enforcement_active(workspace)
    )


def resolve_effective_mc_history(
    obj: Program | Project | Workspace,
    key: str,
    *,
    workspace: Workspace | None = None,
) -> Any:
    """Resolve the effective value of ``key`` for a project, program, or workspace.

    Walks the override chain Project → Program → Workspace → Django settings default,
    returning the first non-null value found. ``obj`` may be a ``Project`` (resolved
    up its program → workspace), a ``Program`` (resolved up to the workspace), or the
    ``Workspace`` itself (its own non-null column).

    ``workspace`` may be passed to avoid re-loading the singleton per object when
    resolving a list (the serializer caches it once); otherwise it is loaded here.

    Args:
        obj: The Project, Program, or Workspace to resolve for.
        key: One of ``MC_HISTORY_FIELDS``.
        workspace: Optional pre-loaded Workspace singleton.

    Returns:
        The effective value (clamped for the retention cap).
    """
    from trueppm_api.apps.workspace.models import Workspace as WorkspaceModel

    if workspace is None:
        workspace = WorkspaceModel.load()

    # Resolving the workspace itself: its own non-null column (or settings default,
    # defensive — the column is non-null so this falls through to the value).
    if isinstance(obj, WorkspaceModel):
        ws_value = getattr(obj, key)
        return _clamp(key, ws_value if ws_value is not None else _settings_default(key))

    if _enforced(workspace):
        # Enterprise lock: the workspace value wins regardless of lower overrides.
        return _clamp(key, getattr(workspace, key))

    own = getattr(obj, key)  # nullable override on Program/Project
    if own is not None:
        return _clamp(key, own)
    return _clamp(key, _parent_value(obj, key, workspace=workspace))


def resolve_inherited_mc_history(
    obj: Program | Project,
    key: str,
    *,
    workspace: Workspace | None = None,
) -> Any:
    """Value ``obj`` would inherit if its own override were cleared.

    Drives the settings "Inherit (…)" affordance — it deliberately skips ``obj``'s
    own override and resolves from the parent up. Under an active Enterprise lock the
    inherited value is the (locked) workspace value.

    Args:
        obj: The Program or Project to resolve the inherited value for.
        key: One of ``MC_HISTORY_FIELDS``.
        workspace: Optional pre-loaded Workspace singleton.

    Returns:
        The value ``obj`` would resolve to with its own override cleared.
    """
    from trueppm_api.apps.workspace.models import Workspace as WorkspaceModel

    if workspace is None:
        workspace = WorkspaceModel.load()

    if _enforced(workspace):
        return _clamp(key, getattr(workspace, key))
    return _clamp(key, _parent_value(obj, key, workspace=workspace))


def _parent_value(
    obj: Program | Project,
    key: str,
    *,
    workspace: Workspace,
) -> Any:
    """Resolve ``key`` from ``obj``'s parent scope up to the workspace value.

    A Program's parent is the workspace. A Project's parent is its program (whose
    own override resolves up to the workspace) or, if standalone, the workspace.
    The workspace columns are non-null, so the chain always terminates in a
    concrete value (no settings-default fall-through is needed below the workspace).
    """
    # Local import keeps this module import-safe from migrations.
    from trueppm_api.apps.projects.models import Program

    program: Program | None = None
    if not isinstance(obj, Program) and obj.program_id:
        program = obj.program

    if program is not None:
        program_override = getattr(program, key)
        if program_override is not None:
            return program_override

    ws_value = getattr(workspace, key)
    return ws_value if ws_value is not None else _settings_default(key)
