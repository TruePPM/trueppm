"""Workspace → Program → Project methodology resolution (ADR-0107, issue 955).

The planning *methodology* (``AGILE`` / ``WATERFALL`` / ``HYBRID``) is the
"experience preset" that hides one workflow's chrome from the other (ADR-0041 —
the API surface and CPM substrate are unchanged; only tab visibility shifts). It
is set at three scopes; the *effective* methodology a project displays is resolved
here, computed-on-read (ADR-0108) — there is no stored/denormalized effective
column to keep in sync. Clients (web, mobile, MCP) read the serializer's
``effective_methodology``; they never re-implement this precedence.

**Crucial difference from iteration_label / sharing inheritance:** methodology is
NOT-NULL on every scope (Workspace/Program/Project each always carry a concrete
value — there is no null "inherit" sentinel). So inheritance is **policy-driven**,
not override-presence driven. The single switch is the workspace's
``methodology_override_policy``:

- ``SUGGEST`` (default) → each scope's own ``methodology`` is honored; the
  workspace default merely pre-fills new projects. Precedence:
  project.methodology → program.methodology → workspace.methodology.
- ``INHERIT`` → the workspace default wins for every scope; the per-scope picker
  is read-only ("Inherited from workspace").
- ``ENFORCE`` → the workspace default is mandatory and the per-scope override is
  blocked. ``ENFORCE`` is an Enterprise capability (trueppm-enterprise#144); OSS
  ships the neutral hook below and registers no provider, so ``ENFORCE`` degrades
  to ``SUGGEST`` (no lock — the per-scope override wins and the methodology PATCH
  is allowed).

OSS never imports enterprise. trueppm-enterprise registers a provider in its
``AppConfig.ready()`` — the integrations-registry idiom (ADR-0029/0049), mirroring
``iteration_label.register_terminology_enforcement_provider`` and
``sharing_settings.register_sharing_enforcement_provider``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from trueppm_api.apps.projects.models import Methodology

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Program, Project
    from trueppm_api.apps.workspace.models import Workspace

#: System backstop when nothing up the chain sets a methodology. Mirrors the
#: model defaults (HYBRID shows every tab — the safe, lossless default).
DEFAULT_METHODOLOGY = Methodology.HYBRID

# Enterprise registers a zero-arg predicate that returns True when methodology
# enforcement is licensed/active. OSS leaves it None → enforcement inactive, so
# a workspace ENFORCE policy never locks downstream overrides in the community
# edition.
_ENFORCEMENT_PROVIDER: Callable[[], bool] | None = None


def register_methodology_enforcement_provider(provider: Callable[[], bool] | None) -> None:
    """Register (or clear) the methodology-enforcement provider. Enterprise calls this."""
    global _ENFORCEMENT_PROVIDER
    _ENFORCEMENT_PROVIDER = provider


def methodology_enforcement_active() -> bool:
    """True only when an enterprise provider is registered AND reports active.

    OSS has no provider → always False, so a workspace ``ENFORCE`` policy never
    locks downstream methodology overrides in the community edition.
    """
    return _ENFORCEMENT_PROVIDER is not None and bool(_ENFORCEMENT_PROVIDER())


def methodology_override_locked(workspace: Workspace) -> bool:
    """Whether per-scope methodology overrides are locked to the workspace default.

    True under ``INHERIT`` (always — the affordance is hidden by design) or under
    ``ENFORCE`` *with* an active enterprise provider. ``SUGGEST`` (and OSS
    ``ENFORCE`` with no provider) returns False, so the per-scope override is
    honored and editable. This is the single predicate the serializer and the
    write-permission gate both consult, so resolution and enforcement can never
    drift apart.
    """
    from trueppm_api.apps.workspace.models import TermOverridePolicy

    policy = workspace.methodology_override_policy
    if policy == TermOverridePolicy.INHERIT:
        return True
    if policy == TermOverridePolicy.ENFORCE:
        return methodology_enforcement_active()
    return False


def resolve_effective_methodology(
    obj: Program | Project, *, workspace: Workspace | None = None
) -> str:
    """Resolve the effective methodology a program or project should display.

    ``workspace`` may be passed to avoid re-loading the singleton per object when
    resolving a list (the serializer caches it once); otherwise it is loaded here.
    """
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    if methodology_override_locked(workspace):
        # INHERIT / active ENFORCE: the workspace default wins regardless of any
        # lower-scope value.
        return workspace.methodology or DEFAULT_METHODOLOGY

    # SUGGEST (or OSS ENFORCE with no provider): each scope's own value wins, then
    # the program tier, then the workspace default. Every value is non-null, so
    # this short-circuits at the object itself in the common case.
    from trueppm_api.apps.projects.models import Program

    own = obj.methodology
    if own:
        return own
    program = obj.program if (not isinstance(obj, Program) and obj.program_id) else None
    program_value = program.methodology if program else None
    return program_value or workspace.methodology or DEFAULT_METHODOLOGY


def resolve_inherited_methodology(
    obj: Program | Project, *, workspace: Workspace | None = None
) -> str:
    """Methodology ``obj`` would display if its own override were ignored.

    Drives the settings "Inherited from workspace (X)" affordance — it skips
    ``obj``'s own value and resolves from the parent scope up. A Program's parent
    is the workspace; a Project's parent is its program (whose own value resolves
    up to the workspace) or, standalone, the workspace. Under an active lock the
    inherited value is the (mandatory) workspace default.
    """
    from trueppm_api.apps.projects.models import Program
    from trueppm_api.apps.workspace.models import Workspace

    if workspace is None:
        workspace = Workspace.load()

    if methodology_override_locked(workspace):
        return workspace.methodology or DEFAULT_METHODOLOGY

    program = obj.program if (not isinstance(obj, Program) and obj.program_id) else None
    program_value = program.methodology if program else None
    return program_value or workspace.methodology or DEFAULT_METHODOLOGY
