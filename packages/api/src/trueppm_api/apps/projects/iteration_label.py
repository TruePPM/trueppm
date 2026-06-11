"""Workspace → Program → Project iteration-label resolution (ADR-0116, #1106).

The displayed iteration-container noun ("Sprint" / "Iteration" / "PI" / custom)
can be set at three scopes. The *effective* label for a project is resolved here,
computed-on-read (ADR-0108) — there is no stored/denormalized effective column to
keep in sync. Clients (web, mobile, MCP) read the serializer's
``effective_iteration_label``; they never re-implement this precedence.

Precedence: project override → program override → workspace default → ``"Sprint"``.

``ENFORCE`` (a workspace admin locking the term so lower scopes cannot override it)
is an Enterprise capability. OSS ships the neutral hook below and registers no
provider, so ``ENFORCE`` degrades to ``SUGGEST`` (no lock). trueppm-enterprise
registers a provider in its ``AppConfig.ready()`` (trueppm-enterprise#154) — the
integrations-registry idiom (ADR-0029/0049), mirroring
``signal_privacy_services.register_default_posture_provider``. OSS never imports
enterprise.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project
    from trueppm_api.apps.workspace.models import Workspace

#: System default when nothing up the chain sets a label. Mirrors the web
#: ``DEFAULT_ITERATION_LABEL`` so the server and client agree on the backstop.
DEFAULT_ITERATION_LABEL = "Sprint"

# Enterprise registers a zero-arg predicate that returns True when terminology
# enforcement is licensed/active. OSS leaves it None → enforcement inactive, so
# ENFORCE behaves as SUGGEST (no lock).
_ENFORCEMENT_PROVIDER: Callable[[], bool] | None = None


def register_terminology_enforcement_provider(provider: Callable[[], bool] | None) -> None:
    """Register (or clear) the terminology-enforcement provider. Enterprise calls this."""
    global _ENFORCEMENT_PROVIDER
    _ENFORCEMENT_PROVIDER = provider


def terminology_enforcement_active() -> bool:
    """True only when an enterprise provider is registered AND reports active.

    OSS has no provider → always False, so a workspace ``ENFORCE`` policy never
    locks downstream overrides in the community edition.
    """
    return _ENFORCEMENT_PROVIDER is not None and bool(_ENFORCEMENT_PROVIDER())


def resolve_effective_iteration_label(
    project: Project, *, workspace: Workspace | None = None
) -> str:
    """Resolve the iteration-container label a project should display.

    ``workspace`` may be passed to avoid re-loading the singleton per project when
    resolving a list (the serializer caches it once); otherwise it is loaded here.
    """
    from trueppm_api.apps.workspace.models import TermOverridePolicy, Workspace

    if workspace is None:
        workspace = Workspace.load()

    if (
        workspace.iteration_label_override_policy == TermOverridePolicy.ENFORCE
        and terminology_enforcement_active()
    ):
        # Enterprise lock: the workspace term wins regardless of lower overrides.
        return workspace.iteration_label or DEFAULT_ITERATION_LABEL

    program = project.program if project.program_id else None
    program_label = program.iteration_label if program else None
    return (
        project.iteration_label
        or program_label
        or workspace.iteration_label
        or DEFAULT_ITERATION_LABEL
    )
